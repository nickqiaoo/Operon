package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// AgentConn is one agent's tunnel. The node leg is a long-lived SSE downlink
// (broker→node frames) plus a series of discrete JSON POSTs for the uplink
// (node→broker frames, batched) — no WebSocket, and no never-ending request body
// either: CDNs and corporate proxies buffer request bodies whole, so a body that
// never ends never reaches the origin. The internal model is transport-agnostic: a
// single writer (runWriteLoop, draining `outbound` to the SSE response), a single
// dispatcher (runDispatchLoop, draining `inbox`), and a table of in-flight requests
// multiplexed by id. See protocol §1.
type AgentConn struct {
	connID    string
	userID    string
	nodeID    string
	label     string
	sessionID string

	ctx    context.Context // connection lifetime; cancelled on teardown
	cancel context.CancelFunc

	outbound chan *Frame // all frames to the agent funnel through the writer goroutine
	inbox    chan Frame  // frames off the uplink, drained by runDispatchLoop

	// Uplink batch state. upMu serialises applyBatch across the (independent) POST
	// handlers; lastSeq is the dedup/gap watermark; lastUpAt feeds the stall backstop.
	upMu     sync.Mutex
	lastSeq  uint64
	lastUpAt atomic.Int64

	mu        sync.Mutex
	pending   map[string]*pendingReq
	wsStreams map[string]*wsStream
	seq       uint64
}

// errSeqGap means the uplink skipped a batch. See applyBatch.
var errSeqGap = errors.New("uplink sequence gap")

// uplinkStallTimeout bounds how long a conn may go without ANY accepted uplink
// batch before we assume the node is gone. Deliberately generous: a stalled uplink
// is NOT an error — the node retries indefinitely rather than dropping frames, and
// the browser is held warm by SSE keepalives meanwhile (see http_proxy.go) — so this
// is a leak backstop, not a liveness probe. The node's contract is to send an empty
// keepalive batch every 60s, so anything near this bound is genuinely dead.
const uplinkStallTimeout = 10 * time.Minute

type AgentConnStats struct {
	PendingRequests int
	WSStreams       int
}

// respEvent is one step of a response stream, handed from the read loop to the
// waiting HTTP handler.
type respEvent struct {
	kind  int
	frame *Frame // set for head/error
	data  []byte // set for chunk
}

const (
	evHead = iota
	evChunk
	evEnd
	evError
)

// pendingReq carries a single request's response back to its HTTP handler.
//
// Design note: we never close `events`. Completion is signalled by an evEnd/evError
// event; the read loop removes the pending from the map at the same moment, so no
// further events are dispatched. This sidesteps the send-on-closed-channel race
// without per-request locking.
//
// `ctx` is derived from the *connection* lifetime, NOT the browser request — so
// push() keeps delivering the node's chunks even after the browser disconnects.
// That is what lets the chat buffer keep filling for a later resume. The HTTP
// handler watches the browser request context separately; `cancel` is called to
// tear the request down (explicit cancel, normal completion, or conn death).
type pendingReq struct {
	id     string
	ctx    context.Context
	cancel context.CancelFunc
	events chan respEvent
}

func (p *pendingReq) push(e respEvent) {
	select {
	case p.events <- e:
	case <-p.ctx.Done():
	}
}

// wsStream is one tunneled browser WebSocket (Phase 4). Frames from the agent
// (ws-msg / ws-close / ws-ack) are pushed onto `events`; the HTTP handler that owns
// the browser WS drains them and writes to the browser. `ctx` is the browser WS
// request context — push() bails the instant the browser goes away. Like pendingReq,
// `events` is never closed; the handler exits on a wsEvClose event or ctx cancel.
type wsStream struct {
	id     string
	ctx    context.Context
	events chan wsEvent
}

type wsEvent struct {
	kind   int
	data   []byte // wsEvMsg
	wsCode int    // wsEvClose
	reason string // wsEvClose
	ok     bool   // wsEvAck
}

const (
	wsEvMsg = iota
	wsEvClose
	wsEvAck
)

func (s *wsStream) push(e wsEvent) {
	select {
	case s.events <- e:
	case <-s.ctx.Done():
	}
}

func newAgentConn(connID, userID, nodeID, label, sessionID string) *AgentConn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &AgentConn{
		connID:    connID,
		userID:    userID,
		nodeID:    nodeID,
		label:     label,
		sessionID: sessionID,
		ctx:       ctx,
		cancel:    cancel,
		outbound:  make(chan *Frame, 64),
		inbox:     make(chan Frame, 256),
		pending:   make(map[string]*pendingReq),
		wsStreams: make(map[string]*wsStream),
	}
	c.lastUpAt.Store(time.Now().UnixMilli())
	return c
}

func (c *AgentConn) nextID() string {
	n := atomic.AddUint64(&c.seq, 1)
	return c.sessionID + "-" + strconv.FormatUint(n, 10)
}

// send enqueues a frame for the writer goroutine (never write the WS directly).
func (c *AgentConn) send(f *Frame) {
	select {
	case c.outbound <- f:
	case <-c.ctx.Done():
	}
}

// runWriteLoop is the sole frame writer: it drains `outbound` to the SSE downlink as
// `data: <json>\n\n` events. Runs inside the GET /agent/down handler, which owns the
// response writer. Returns when the connection is cancelled or a write fails.
func (c *AgentConn) runWriteLoop(w http.ResponseWriter) {
	rc := http.NewResponseController(w)
	for {
		select {
		case f := <-c.outbound:
			data, err := json.Marshal(f)
			if err != nil {
				continue
			}
			_ = rc.SetWriteDeadline(time.Now().Add(15 * time.Second))
			if _, err := w.Write([]byte("data: ")); err != nil {
				c.cancel()
				return
			}
			if _, err := w.Write(data); err != nil {
				c.cancel()
				return
			}
			if _, err := w.Write([]byte("\n\n")); err != nil {
				c.cancel()
				return
			}
			if err := rc.Flush(); err != nil {
				c.cancel()
				return
			}
		case <-c.ctx.Done():
			return
		}
	}
}

// heartbeat drives both halves of liveness detection.
//
// Downlink: the ping's real job is not the reply but the WRITE — an idle SSE stream
// is never written to, so a dead socket goes unnoticed until something is sent. The
// 15s write deadline in runWriteLoop turns each ping into a probe.
//
// Uplink: there is no socket to probe (the POSTs are discrete), so we watch the
// watermark the node refreshes with every batch, including its idle keepalives.
func (c *AgentConn) heartbeat() {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if since := time.Since(time.UnixMilli(c.lastUpAt.Load())); since > uplinkStallTimeout {
				slog.Warn("broker: uplink stalled, dropping conn",
					"node", c.nodeID, "conn", c.connID, "stalled_for", since.Round(time.Second))
				c.cancel()
				return
			}
			c.send(&Frame{T: FramePing, TS: time.Now().UnixMilli()})
		case <-c.ctx.Done():
			return
		}
	}
}

// applyBatch admits one uplink POST's worth of frames. It is the whole ordering and
// exactly-once story on the broker side:
//
//   - The node keeps at most one POST in flight and only mints seq N+1 after N was
//     acknowledged, so wire order is generation order and gaps cannot occur.
//   - A retry (our 200 was lost in transit) re-sends the SAME seq, which we discard
//     without looking at the contents — so, unlike per-event-id schemes, a retry does
//     not have to reproduce its payload byte-for-byte to stay idempotent.
//   - Because dedup is by watermark, it is immune to arrival order: if a timed-out
//     attempt lands AFTER its own retry, the late copy is simply below the mark.
//
// Frames go onto `inbox` rather than being dispatched here, so the single-dispatcher
// invariant that pendingReq relies on survives having many POST handlers. Blocking on
// a full inbox is the intended backpressure: the POST doesn't return, so the node
// holds its queue instead of racing ahead.
func (c *AgentConn) applyBatch(seq uint64, events []Frame) error {
	c.upMu.Lock()
	defer c.upMu.Unlock()
	if seq <= c.lastSeq {
		c.lastUpAt.Store(time.Now().UnixMilli())
		return nil // already applied; idempotent no-op
	}
	if seq > c.lastSeq+1 {
		// Unreachable if the node honours the serial contract, so a gap means frames
		// are gone for good and the response bodies riding on them are already
		// corrupt. Fail the connection rather than hand the browser a silently
		// truncated stream.
		return errSeqGap
	}
	for i := range events {
		select {
		case c.inbox <- events[i]:
		case <-c.ctx.Done():
			return context.Canceled
		}
	}
	c.lastSeq = seq
	c.lastUpAt.Store(time.Now().UnixMilli())
	return nil
}

// runDispatchLoop is the sole frame consumer: it drains `inbox` in order. Keeping
// this one goroutine — as the old streaming-uplink read loop was — is what makes the
// no-close pendingReq design safe (see pendingReq). Runs for the conn's lifetime.
func (c *AgentConn) runDispatchLoop() {
	for {
		select {
		case f := <-c.inbox:
			c.dispatch(&f)
		case <-c.ctx.Done():
			return
		}
	}
}

// dispatch routes one inbound frame to its waiter. Frames kept beyond this call
// (head/error) are copied because `f` points at the dispatch loop's scratch frame.
func (c *AgentConn) dispatch(f *Frame) {
	switch f.T {
	case FramePong:
		// Legacy liveness ack. Uplink liveness now rides on lastUpAt (any batch,
		// including the node's empty keepalive, refreshes it), so the node no longer
		// replies to every ping. Accepted for compatibility; nothing to do.
	case FramePing:
		c.send(&Frame{T: FramePong, TS: f.TS})
	case FrameResHead:
		if p := c.getPending(f.ID); p != nil {
			hf := *f
			p.push(respEvent{kind: evHead, frame: &hf})
		}
	case FrameResChunk:
		if p := c.getPending(f.ID); p != nil {
			p.push(respEvent{kind: evChunk, data: decodeData(f.Data, f.Enc)})
		}
	case FrameResEnd:
		if p := c.takePending(f.ID); p != nil {
			p.push(respEvent{kind: evEnd})
		}
	case FrameRes:
		// Unary fast-path: synthesize head + one chunk + end.
		if p := c.takePending(f.ID); p != nil {
			hf := *f
			p.push(respEvent{kind: evHead, frame: &hf})
			if b := decodeData(f.Body, f.Enc); len(b) > 0 {
				p.push(respEvent{kind: evChunk, data: b})
			}
			p.push(respEvent{kind: evEnd})
		}
	case FrameResError:
		if p := c.takePending(f.ID); p != nil {
			ef := *f
			p.push(respEvent{kind: evError, frame: &ef})
		}
	case FrameWSAck:
		if st := c.getWS(f.ID); st != nil {
			ok := f.OK == nil || *f.OK
			st.push(wsEvent{kind: wsEvAck, ok: ok})
		}
	case FrameWSMsg:
		if st := c.getWS(f.ID); st != nil {
			st.push(wsEvent{kind: wsEvMsg, data: decodeData(f.Data, f.Enc)})
		}
	case FrameWSClose:
		if st := c.takeWS(f.ID); st != nil {
			st.push(wsEvent{kind: wsEvClose, wsCode: f.WSCode, reason: f.Reason})
		}
	default:
		slog.Debug("broker: unknown frame from agent", "t", f.T, "node", c.nodeID)
	}
}

// startRequest registers a pending, sends the `req` frame, and returns the handle
// the HTTP handler drains. The pending's context is derived from the connection so
// it outlives the browser request (see pendingReq); the handler must call
// p.cancel() (directly or via cancelRequest) when it is truly done to avoid leaking
// the context.
func (c *AgentConn) startRequest(f *Frame) *pendingReq {
	ctx, cancel := context.WithCancel(c.ctx)
	p := &pendingReq{id: f.ID, ctx: ctx, cancel: cancel, events: make(chan respEvent, 64)}
	c.mu.Lock()
	c.pending[f.ID] = p
	c.mu.Unlock()
	c.send(f)
	return p
}

// cancelRequest drops the pending, cancels its context (so push() stops), and tells
// the agent to abort the local fetch. Critical for chat: /api/ai/chat ties
// generation to the request signal. Idempotent.
func (c *AgentConn) cancelRequest(id, reason string) {
	c.mu.Lock()
	p := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if p != nil {
		p.cancel()
	}
	c.send(&Frame{T: FrameCancel, ID: id, Reason: reason})
}

func (c *AgentConn) Stats() AgentConnStats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return AgentConnStats{
		PendingRequests: len(c.pending),
		WSStreams:       len(c.wsStreams),
	}
}

func (c *AgentConn) closeIfIdleForDrain() bool {
	stats := c.Stats()
	if stats.PendingRequests != 0 || stats.WSStreams != 0 {
		return false
	}
	c.send(&Frame{T: FrameClose, Code: "server_draining", Message: "broker is draining; reconnect"})
	c.cancel()
	return true
}

func (c *AgentConn) getPending(id string) *pendingReq {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pending[id]
}

func (c *AgentConn) takePending(id string) *pendingReq {
	c.mu.Lock()
	defer c.mu.Unlock()
	p := c.pending[id]
	if p != nil {
		delete(c.pending, id)
	}
	return p
}

// openWS registers a tunneled-WebSocket stream and sends the ws-open frame. reqCtx
// is the browser WS request context.
func (c *AgentConn) openWS(reqCtx context.Context, id, path, query string, headers map[string][]string) *wsStream {
	st := &wsStream{id: id, ctx: reqCtx, events: make(chan wsEvent, 64)}
	c.mu.Lock()
	c.wsStreams[id] = st
	c.mu.Unlock()
	c.send(&Frame{T: FrameWSOpen, ID: id, Path: path, Query: query, Headers: headers})
	return st
}

func (c *AgentConn) getWS(id string) *wsStream {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wsStreams[id]
}

func (c *AgentConn) takeWS(id string) *wsStream {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.wsStreams[id]
	if st != nil {
		delete(c.wsStreams, id)
	}
	return st
}

// closeWS tears down a stream and tells the agent to close the local WS. Idempotent
// (the agent may have already closed it via ws-close, which takeWS'd the stream).
func (c *AgentConn) closeWS(id string, wsCode int, reason string) {
	c.mu.Lock()
	_, existed := c.wsStreams[id]
	delete(c.wsStreams, id)
	c.mu.Unlock()
	if existed {
		c.send(&Frame{T: FrameWSClose, ID: id, WSCode: wsCode, Reason: reason})
	}
}

// sendWSMsg forwards one browser→agent WebSocket message.
func (c *AgentConn) sendWSMsg(id string, data []byte) {
	d, enc := encodeBytes(data)
	c.send(&Frame{T: FrameWSMsg, ID: id, Data: d, Enc: enc})
}
