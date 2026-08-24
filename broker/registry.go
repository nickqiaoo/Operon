package main

import "sync"

// Registry is the two-level connection table: userId -> nodeId -> live agent conn.
// A user may run several nodes (home/work/server) that coexist; the web client
// addresses one via /u/<uid>/n/<nid>/. See protocol §0, §5.
type Registry struct {
	mu    sync.RWMutex
	users map[string]map[string]*AgentConn
}

type RegistryStats struct {
	LiveConns       int
	PendingRequests int
	WSStreams       int
}

// NodeInfo is the public shape returned by GET /u/<uid>/nodes (the picker source).
type NodeInfo struct {
	NodeID string `json:"nodeId"`
	Label  string `json:"label"`
	Online bool   `json:"online"`
}

func NewRegistry() *Registry {
	return &Registry{users: make(map[string]map[string]*AgentConn)}
}

// Register installs c under (userID, nodeID) and returns the previous conn for the
// SAME nodeID (if any) so the caller can supersede it. Different nodeIds coexist.
func (r *Registry) Register(userID, nodeID string, c *AgentConn) (superseded *AgentConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	nodes := r.users[userID]
	if nodes == nil {
		nodes = make(map[string]*AgentConn)
		r.users[userID] = nodes
	}
	old := nodes[nodeID]
	nodes[nodeID] = c
	return old
}

// Unregister removes c only if it is still the current conn for (userID, nodeID)
// — guards against a reconnect/supersede having already replaced it.
func (r *Registry) Unregister(userID, nodeID string, c *AgentConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	nodes := r.users[userID]
	if nodes == nil {
		return
	}
	if nodes[nodeID] == c {
		delete(nodes, nodeID)
		if len(nodes) == 0 {
			delete(r.users, userID)
		}
	}
}

// Get returns the live conn for (userID, nodeID), if online.
func (r *Registry) Get(userID, nodeID string) (*AgentConn, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	nodes := r.users[userID]
	if nodes == nil {
		return nil, false
	}
	c := nodes[nodeID]
	return c, c != nil
}

// ListNodes returns the user's currently-online nodes. (Offline nodes come from the
// auth server's `nodes` table in Phase 2; PoC only knows live connections.)
func (r *Registry) ListNodes(userID string) []NodeInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := []NodeInfo{}
	for nid, c := range r.users[userID] {
		out = append(out, NodeInfo{NodeID: nid, Label: c.label, Online: true})
	}
	return out
}

func (r *Registry) Stats() RegistryStats {
	conns := r.snapshotConns()
	var out RegistryStats
	out.LiveConns = len(conns)
	for _, c := range conns {
		stats := c.Stats()
		out.PendingRequests += stats.PendingRequests
		out.WSStreams += stats.WSStreams
	}
	return out
}

func (r *Registry) CloseIdleForDrain() int {
	closed := 0
	for _, c := range r.snapshotConns() {
		if c.closeIfIdleForDrain() {
			closed++
		}
	}
	return closed
}

func (r *Registry) snapshotConns() []*AgentConn {
	r.mu.RLock()
	defer r.mu.RUnlock()
	conns := make([]*AgentConn, 0)
	for _, nodes := range r.users {
		for _, c := range nodes {
			conns = append(conns, c)
		}
	}
	return conns
}
