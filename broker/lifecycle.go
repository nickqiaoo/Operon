package main

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	drainKeyTTL       = 15 * time.Second
	drainRefreshEvery = 5 * time.Second
	drainSweepEvery   = 1 * time.Second
)

type lifecycleState string

const (
	lifecycleAccepting lifecycleState = "accepting"
	lifecycleDraining  lifecycleState = "draining"
)

type Lifecycle struct {
	mu            sync.RWMutex
	state         lifecycleState
	drainingSince time.Time
	adminToken    string
	dir           *Directory
}

type BrokerStatus struct {
	State             string `json:"state"`
	Ready             bool   `json:"ready"`
	Instance          string `json:"instance,omitempty"`
	DrainingSince     string `json:"drainingSince,omitempty"`
	LiveConns         int    `json:"liveConns"`
	OpenConns         int    `json:"openConns"`
	PendingRequests   int    `json:"pendingRequests"`
	WSStreams         int    `json:"wsStreams"`
}

func NewLifecycle(dir *Directory, adminToken string) *Lifecycle {
	return &Lifecycle{state: lifecycleAccepting, adminToken: adminToken, dir: dir}
}

func (l *Lifecycle) IsDraining() bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.state == lifecycleDraining
}

func (l *Lifecycle) Drain(ctx context.Context) error {
	l.mu.Lock()
	if l.state != lifecycleDraining {
		l.state = lifecycleDraining
		l.drainingSince = time.Now().UTC()
	}
	l.mu.Unlock()
	return l.publishDrain(ctx)
}

func (l *Lifecycle) Undrain(ctx context.Context) {
	l.mu.Lock()
	l.state = lifecycleAccepting
	l.drainingSince = time.Time{}
	l.mu.Unlock()
	l.dir.delDrain(ctx)
}

func (l *Lifecycle) publishDrain(ctx context.Context) error {
	return l.dir.setDrain(ctx, drainKeyTTL)
}

func (l *Lifecycle) snapshot() (lifecycleState, time.Time) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.state, l.drainingSince
}

func (l *Lifecycle) adminEnabled() bool {
	return l != nil && l.adminToken != ""
}

func (l *Lifecycle) adminAllowed(r *http.Request) bool {
	if !l.adminEnabled() {
		return false
	}
	got := r.Header.Get("X-Admin-Token")
	if got == "" {
		authz := r.Header.Get("Authorization")
		if strings.HasPrefix(authz, "Bearer ") {
			got = strings.TrimPrefix(authz, "Bearer ")
		}
	}
	want := l.adminToken
	if len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (s *Server) runDrainLoop(ctx context.Context) {
	refresh := time.NewTicker(drainRefreshEvery)
	sweep := time.NewTicker(drainSweepEvery)
	defer refresh.Stop()
	defer sweep.Stop()
	for {
		select {
		case <-refresh.C:
			if s.lifecycle.IsDraining() {
				if err := s.publishDrainWithTimeout(); err != nil {
					slog.Warn("broker: drain refresh failed", "err", err)
				}
			}
		case <-sweep.C:
			if s.lifecycle.IsDraining() {
				s.closeIdleForDrain()
			}
		case <-ctx.Done():
			return
		}
	}
}

func (s *Server) publishDrainWithTimeout() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return s.lifecycle.publishDrain(ctx)
}

func (s *Server) statusSnapshot() BrokerStatus {
	state, since := s.lifecycle.snapshot()
	stats := s.reg.Stats()
	out := BrokerStatus{
		State:             string(state),
		Ready:             state != lifecycleDraining,
		LiveConns:         stats.LiveConns,
		OpenConns:         s.conns.Count(),
		PendingRequests:   stats.PendingRequests,
		WSStreams:         stats.WSStreams,
	}
	if s.dir != nil {
		out.Instance = routeAddr(s.dir.self)
	}
	if !since.IsZero() {
		out.DrainingSince = since.Format(time.RFC3339)
	}
	return out
}

// closeIdleForDrain only walks the registry: every open conn is registered the
// moment its downlink lands, so there is no second, pre-registration set to sweep.
func (s *Server) closeIdleForDrain() int {
	return s.reg.CloseIdleForDrain()
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if s.lifecycle.IsDraining() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "draining"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "store_unavailable"})
		return
	}
	if err := s.dir.ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": "directory_unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !s.lifecycle.adminEnabled() {
		http.NotFound(w, r)
		return false
	}
	if !s.lifecycle.adminAllowed(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	return true
}

func (s *Server) handleAdminStatus(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, s.statusSnapshot())
}

func (s *Server) handleAdminDrain(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.lifecycle.Drain(ctx); err != nil {
		slog.Warn("broker: drain publish failed", "err", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "drain_publish_failed"})
		return
	}
	s.closeIdleForDrain()
	writeJSON(w, http.StatusOK, s.statusSnapshot())
}

func (s *Server) handleAdminUndrain(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	s.lifecycle.Undrain(ctx)
	writeJSON(w, http.StatusOK, s.statusSnapshot())
}

func writeServerDraining(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "server_draining"})
}
