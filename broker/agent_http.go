package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
)

// agent_http.go is the node↔broker tunnel transport: one long-lived SSE downlink
// (broker→node frames) plus discrete JSON POSTs for the uplink (node→broker frames),
// correlated by a broker-minted connId:
//
//   1. GET  /agent/down       — authenticate, mint connId, register the conn, emit
//                               `welcome` (carries connId), then run the write loop.
//   2. POST /agent/up?connId= — authenticate, look the conn up, apply one ordered
//                               batch of frames, return. Repeated for the conn's life.
//
// The downlink alone defines the connection's lifetime: it opening is what makes the
// node reachable, and it closing is what tears everything down. The uplink is
// stateless by comparison — any single POST may fail and be retried without
// consequence, which is the point. An earlier revision streamed the uplink as one
// never-ending POST body; CDNs and proxies buffer request bodies whole, so such a
// body never reaches the origin at all.
//
// Node auth is a normal Bearer header on both legs, not a hello frame.

// ConnTable indexes live conns by connId so each uplink POST can find its
// connection. Note this is a lookup, not a take: a conn is added when its downlink
// opens and removed only when that downlink closes.
type ConnTable struct {
	mu sync.Mutex
	m  map[string]*AgentConn
}

func NewConnTable() *ConnTable {
	return &ConnTable{m: make(map[string]*AgentConn)}
}

func (t *ConnTable) add(id string, c *AgentConn) {
	t.mu.Lock()
	t.m[id] = c
	t.mu.Unlock()
}

func (t *ConnTable) get(id string) *AgentConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.m[id]
}

// remove drops the mapping only if it still points at c, so a superseded conn
// tearing down late can't unmap its replacement.
func (t *ConnTable) remove(id string, c *AgentConn) {
	t.mu.Lock()
	if t.m[id] == c {
		delete(t.m, id)
	}
	t.mu.Unlock()
}

func (t *ConnTable) Count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.m)
}

// upBatch is the uplink wire envelope: one POST carries an ordered run of frames
// plus a monotonic sequence number. `events` may be empty — that is the node's idle
// keepalive, and the only evidence the broker gets that a quiet uplink still works.
type upBatch struct {
	Seq    uint64  `json:"seq"`
	Events []Frame `json:"events"`
}

// maxUpBatchBytes caps one uplink POST. A single frame can legitimately be large (a
// buffered file response, a big base64 chunk) and the node never splits a frame, so
// this sits well above the node's own batch target rather than near it.
const maxUpBatchBytes = 64 << 20

// requireNode verifies a node JWT (RS256, offline) from the Authorization header.
func (s *Server) requireNode(r *http.Request) (*Claims, error) {
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, "Bearer ") {
		return nil, errors.New("missing bearer token")
	}
	c, err := s.auth.verify(strings.TrimPrefix(authz, "Bearer "))
	if err != nil {
		return nil, err
	}
	if c.Typ != "node" {
		return nil, errors.New("not a node token")
	}
	return c, nil
}

// handleAgentDown: GET /agent/down — the SSE downlink. Authenticates, creates the
// AgentConn, and serves frames until the node disconnects.
func (s *Server) handleAgentDown(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireNode(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if s.lifecycle.IsDraining() {
		writeServerDraining(w)
		return
	}
	// The authoritative userId/nodeId come from the CLAIMS, never self-reported query
	// params — that is the multi-tenant trust boundary.
	node, ok, err := s.store.GetNode(claims.NodeID)
	if err != nil {
		// DB blip is infra, not auth: 503 so the node backs off and retries instead of
		// treating it as a permanent rejection.
		http.Error(w, `{"error":"internal"}`, http.StatusServiceUnavailable)
		return
	}
	if !ok || node.RevokedAt != 0 || node.UserID != claims.Subject {
		http.Error(w, `{"error":"node revoked or unknown"}`, http.StatusForbidden)
		return
	}
	userID := claims.Subject
	nodeID := claims.NodeID
	label := node.Label
	if label == "" {
		label = r.URL.Query().Get("label")
	}
	s.store.TouchNode(nodeID)

	connID := newConnID()
	c := newAgentConn(connID, userID, nodeID, label, newSessionID())

	// Opening the downlink IS the connection: the node can serve requests the moment
	// it has `welcome`, and its replies ride on POSTs that need no prior attach. So
	// everything that used to wait for the uplink to arrive happens here.
	s.conns.add(connID, c)
	defer s.conns.remove(connID, c)
	defer c.cancel()

	if old := s.reg.Register(userID, nodeID, c); old != nil {
		old.send(&Frame{T: FrameClose, Code: "superseded", Message: "another agent connected for this node"})
		old.cancel()
	}
	defer s.reg.Unregister(userID, nodeID, c)

	// Publish (and keep fresh) the node→owner and conn→owner routes for the front
	// router; every uplink POST is routed by the latter. Drops the node if the
	// directory becomes unreachable, so a zombie owner can't hold an unroutable node.
	go s.dir.heartbeatRoutes(c.ctx, userID, nodeID, connID, c.cancel)
	go c.runDispatchLoop()

	// The node dropping the SSE stream cancels the whole connection (so the write loop
	// unblocks even with no frame pending).
	go func() {
		<-r.Context().Done()
		c.cancel()
	}()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// welcome carries the connId the node needs to open the uplink.
	c.send(&Frame{
		T:             FrameWelcome,
		ConnID:        connID,
		SessionID:     c.sessionID,
		UserID:        userID,
		NodeID:        nodeID,
		HeartbeatMs:   15000,
		MaxInlineBody: 1 << 20,
	})
	go c.heartbeat()
	slog.Info("broker: agent online", "user", userID, "node", nodeID, "label", label, "session", c.sessionID)

	c.runWriteLoop(w) // blocks until the connection ends
	slog.Info("broker: agent offline", "user", userID, "node", nodeID, "conn", connID)
}

// handleAgentUp: POST /agent/up?connId= — one uplink batch. Authenticates, finds the
// conn, applies the batch, returns. Deliberately thin and non-streaming: the node
// may retry any POST indefinitely, so this must be cheap and idempotent.
func (s *Server) handleAgentUp(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireNode(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	connID := r.URL.Query().Get("connId")
	c := s.conns.get(connID)
	if c == nil {
		// OpenResty routes each uplink POST to the instance holding the downlink (by
		// connId, via the Redis directory). A miss means the conn is gone or the route
		// is stale — either way the node must reconnect, so this is terminal for it.
		http.Error(w, `{"error":"unknown_conn"}`, http.StatusNotFound)
		return
	}
	// The token must match the conn's owner — connId alone is not enough.
	if c.userID != claims.Subject || c.nodeID != claims.NodeID {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	var batch upBatch
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxUpBatchBytes))
	if err := dec.Decode(&batch); err != nil {
		http.Error(w, `{"error":"bad_batch"}`, http.StatusBadRequest)
		return
	}

	switch err := c.applyBatch(batch.Seq, batch.Events); {
	case errors.Is(err, errSeqGap):
		slog.Warn("broker: uplink sequence gap, dropping conn",
			"node", c.nodeID, "conn", connID, "got", batch.Seq)
		c.cancel()
		http.Error(w, `{"error":"seq_gap"}`, http.StatusConflict)
	case err != nil:
		// Connection died mid-apply; the node will notice via the downlink.
		http.Error(w, `{"error":"conn_closed"}`, http.StatusNotFound)
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func newConnID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newSessionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
