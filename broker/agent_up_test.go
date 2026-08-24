package main

import (
	"errors"
	"testing"
	"time"
)

// drainEvents collects the response events a pending request receives, stopping at
// the first end/error or after a short quiet period.
func drainEvents(t *testing.T, p *pendingReq) []respEvent {
	t.Helper()
	var got []respEvent
	for {
		select {
		case ev := <-p.events:
			got = append(got, ev)
			if ev.kind == evEnd || ev.kind == evError {
				return got
			}
		case <-time.After(200 * time.Millisecond):
			return got
		}
	}
}

func TestApplyBatchPreservesOrderWithinBatch(t *testing.T) {
	c := newAgentConn("conn-1", "user-1", "node-1", "node", "sess")
	defer c.cancel()
	go c.runDispatchLoop()

	p := c.startRequest(&Frame{T: FrameReq, ID: "req-1"})
	defer p.cancel()

	err := c.applyBatch(1, []Frame{
		{T: FrameResHead, ID: "req-1", Status: 200},
		{T: FrameResChunk, ID: "req-1", Data: "hello "},
		{T: FrameResChunk, ID: "req-1", Data: "world"},
		{T: FrameResEnd, ID: "req-1"},
	})
	if err != nil {
		t.Fatalf("applyBatch: %v", err)
	}

	got := drainEvents(t, p)
	if len(got) != 4 {
		t.Fatalf("got %d events, want 4", len(got))
	}
	if got[0].kind != evHead || got[0].frame.Status != 200 {
		t.Fatalf("event 0 = %+v, want head/200", got[0])
	}
	if string(got[1].data) != "hello " || string(got[2].data) != "world" {
		t.Fatalf("chunks out of order: %q %q", got[1].data, got[2].data)
	}
	if got[3].kind != evEnd {
		t.Fatalf("event 3 kind = %d, want evEnd", got[3].kind)
	}
}

// A retry re-sends the same seq because our 200 was lost, not because anything
// changed. Applying it twice would duplicate bytes in the browser's response body.
func TestApplyBatchIsIdempotentOnReplay(t *testing.T) {
	c := newAgentConn("conn-1", "user-1", "node-1", "node", "sess")
	defer c.cancel()
	go c.runDispatchLoop()

	p := c.startRequest(&Frame{T: FrameReq, ID: "req-1"})
	defer p.cancel()

	batch := []Frame{{T: FrameResChunk, ID: "req-1", Data: "once"}}
	if err := c.applyBatch(1, batch); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	// Same seq, deliberately different contents: dedup is by watermark, so the
	// payload is never even inspected.
	if err := c.applyBatch(1, []Frame{{T: FrameResChunk, ID: "req-1", Data: "twice"}}); err != nil {
		t.Fatalf("replay: %v", err)
	}

	got := drainEvents(t, p)
	if len(got) != 1 {
		t.Fatalf("got %d events, want 1 (replay must not re-apply)", len(got))
	}
	if string(got[0].data) != "once" {
		t.Fatalf("chunk = %q, want %q", got[0].data, "once")
	}
}

// Out-of-order arrival happens when a timed-out attempt lands after its own retry.
// The watermark makes the late copy a no-op regardless of which arrives first.
func TestApplyBatchToleratesLateDuplicate(t *testing.T) {
	c := newAgentConn("conn-1", "user-1", "node-1", "node", "sess")
	defer c.cancel()
	go c.runDispatchLoop()

	p := c.startRequest(&Frame{T: FrameReq, ID: "req-1"})
	defer p.cancel()

	if err := c.applyBatch(1, []Frame{{T: FrameResChunk, ID: "req-1", Data: "a"}}); err != nil {
		t.Fatalf("seq 1: %v", err)
	}
	if err := c.applyBatch(2, []Frame{{T: FrameResChunk, ID: "req-1", Data: "b"}}); err != nil {
		t.Fatalf("seq 2: %v", err)
	}
	// The original seq-1 attempt finally arrives.
	if err := c.applyBatch(1, []Frame{{T: FrameResChunk, ID: "req-1", Data: "a"}}); err != nil {
		t.Fatalf("late duplicate: %v", err)
	}

	got := drainEvents(t, p)
	if len(got) != 2 {
		t.Fatalf("got %d events, want 2", len(got))
	}
	if string(got[0].data) != "a" || string(got[1].data) != "b" {
		t.Fatalf("chunks = %q %q, want a b", got[0].data, got[1].data)
	}
}

// A gap is unreachable if the node honours the serial contract, so treat it as a
// protocol violation rather than trying to buffer and reorder around it.
func TestApplyBatchRejectsSequenceGap(t *testing.T) {
	c := newAgentConn("conn-1", "user-1", "node-1", "node", "sess")
	defer c.cancel()
	go c.runDispatchLoop()

	if err := c.applyBatch(1, []Frame{{T: FramePong}}); err != nil {
		t.Fatalf("seq 1: %v", err)
	}
	if err := c.applyBatch(3, []Frame{{T: FramePong}}); !errors.Is(err, errSeqGap) {
		t.Fatalf("seq 3 err = %v, want errSeqGap", err)
	}
	// The watermark must not advance on a rejected batch.
	if err := c.applyBatch(2, []Frame{{T: FramePong}}); err != nil {
		t.Fatalf("seq 2 after gap: %v", err)
	}
}

// An empty batch is the node's idle keepalive: it carries no frames but is the only
// evidence the broker gets that a quiet uplink still works.
func TestApplyBatchEmptyKeepaliveRefreshesWatermark(t *testing.T) {
	c := newAgentConn("conn-1", "user-1", "node-1", "node", "sess")
	defer c.cancel()

	c.lastUpAt.Store(time.Now().Add(-time.Hour).UnixMilli())
	if err := c.applyBatch(1, nil); err != nil {
		t.Fatalf("keepalive: %v", err)
	}
	if since := time.Since(time.UnixMilli(c.lastUpAt.Load())); since > time.Minute {
		t.Fatalf("watermark not refreshed (stale by %v)", since)
	}
	if c.lastSeq != 1 {
		t.Fatalf("lastSeq = %d, want 1", c.lastSeq)
	}
}

func TestApplyBatchStopsOnClosedConn(t *testing.T) {
	c := newAgentConn("conn-1", "user-1", "node-1", "node", "sess")
	c.cancel()

	// No dispatch loop is running, so the inbox fills and then the cancelled context
	// releases the writer instead of blocking forever.
	events := make([]Frame, cap(c.inbox)+1)
	for i := range events {
		events[i] = Frame{T: FramePong}
	}
	if err := c.applyBatch(1, events); err == nil {
		t.Fatal("applyBatch on a cancelled conn should fail")
	}
}
