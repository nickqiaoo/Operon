package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAgentConnDrainWaitsForInFlightRequest(t *testing.T) {
	c := newAgentConn("conn-1", "user-1", "node-1", "node", "sess")
	p := c.startRequest(&Frame{T: FrameReq, ID: "req-1"})

	if c.closeIfIdleForDrain() {
		t.Fatal("busy connection should not close during drain")
	}
	select {
	case <-c.ctx.Done():
		t.Fatal("busy connection was cancelled")
	default:
	}

	c.cancelRequest("req-1", "test_done")
	p.cancel()
	if !c.closeIfIdleForDrain() {
		t.Fatal("idle connection should close during drain")
	}
	select {
	case <-c.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("idle connection did not cancel")
	}
}

func TestAgentConnDrainWaitsForWebSocketStream(t *testing.T) {
	c := newAgentConn("conn-1", "user-1", "node-1", "node", "sess")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.openWS(ctx, "ws-1", "/api/terminal/ws", "", nil)

	if c.closeIfIdleForDrain() {
		t.Fatal("connection with ws stream should not close during drain")
	}

	c.closeWS("ws-1", 1000, "done")
	if !c.closeIfIdleForDrain() {
		t.Fatal("connection should close after ws stream is gone")
	}
}

func TestRegistryStatsAndDrainClose(t *testing.T) {
	reg := NewRegistry()
	busy := newAgentConn("busy", "user-1", "node-1", "busy", "sess-a")
	idle := newAgentConn("idle", "user-1", "node-2", "idle", "sess-b")
	busy.startRequest(&Frame{T: FrameReq, ID: "req-1"})
	reg.Register("user-1", "node-1", busy)
	reg.Register("user-1", "node-2", idle)

	stats := reg.Stats()
	if stats.LiveConns != 2 || stats.PendingRequests != 1 || stats.WSStreams != 0 {
		t.Fatalf("stats = %+v, want 2 conns, 1 pending, 0 ws", stats)
	}
	if closed := reg.CloseIdleForDrain(); closed != 1 {
		t.Fatalf("CloseIdleForDrain closed %d conns, want 1", closed)
	}
	select {
	case <-idle.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("idle connection was not cancelled")
	}
	select {
	case <-busy.ctx.Done():
		t.Fatal("busy connection should remain open")
	default:
	}
}

func TestAdminTokenAcceptsBearerOrHeader(t *testing.T) {
	l := NewLifecycle(nil, "secret")

	reqWithHeader := requestWithHeaders(map[string]string{"X-Admin-Token": "secret"})
	if !l.adminAllowed(reqWithHeader) {
		t.Fatal("X-Admin-Token should be accepted")
	}

	reqWithBearer := requestWithHeaders(map[string]string{"Authorization": "Bearer secret"})
	if !l.adminAllowed(reqWithBearer) {
		t.Fatal("Bearer admin token should be accepted")
	}

	reqWrong := requestWithHeaders(map[string]string{"X-Admin-Token": "wrong"})
	if l.adminAllowed(reqWrong) {
		t.Fatal("wrong admin token should be rejected")
	}
}

func requestWithHeaders(headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://broker/admin/status", nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}
