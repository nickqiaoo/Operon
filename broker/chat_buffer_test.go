package main

import (
	"bytes"
	"testing"
	"time"
)

func TestChatBufferReplayAndTail(t *testing.T) {
	b := newChatBuffer(nil, "req-1", time.Now())
	b.append([]byte("a"))
	b.append([]byte("b"))

	// Replay from the start gets everything buffered so far, not yet done.
	chunks, next, done, wait := b.snapshotFrom(0)
	if done {
		t.Fatal("buffer should not be done yet")
	}
	if got := flatten(chunks); got != "ab" {
		t.Fatalf("replay = %q, want %q", got, "ab")
	}
	if next != 2 {
		t.Fatalf("next = %d, want 2", next)
	}

	// A tailer waiting past the current cursor wakes when more data arrives.
	woke := make(chan struct{})
	go func() {
		<-wait
		close(woke)
	}()
	b.append([]byte("c"))
	select {
	case <-woke:
	case <-time.After(time.Second):
		t.Fatal("tailer was not woken by append")
	}

	// Continue from the cursor: only the new chunk, then finish ends the stream.
	chunks, next, _, wait = b.snapshotFrom(next)
	if got := flatten(chunks); got != "c" {
		t.Fatalf("tail = %q, want %q", got, "c")
	}
	doneWoke := make(chan struct{})
	go func() {
		<-wait
		close(doneWoke)
	}()
	b.finish()
	select {
	case <-doneWoke:
	case <-time.After(time.Second):
		t.Fatal("tailer was not woken by finish")
	}
	if _, _, done, _ = b.snapshotFrom(next); !done {
		t.Fatal("buffer should be done after finish")
	}

	// Appends after finish are ignored (the turn is over).
	b.append([]byte("late"))
	if chunks, _, _, _ = b.snapshotFrom(0); flatten(chunks) != "abc" {
		t.Fatalf("post-finish append leaked: %q", flatten(chunks))
	}
}

func TestChatBufferMaxBytesEviction(t *testing.T) {
	b := newChatBuffer(nil, "req-1", time.Now())
	big := bytes.Repeat([]byte("x"), chatBufferMaxBytes)
	b.append(big)         // exactly at cap
	b.append([]byte("y")) // pushes over → oldest chunk dropped
	chunks, _, _, _ := b.snapshotFrom(0)
	if len(chunks) != 1 || string(chunks[0]) != "y" {
		t.Fatalf("expected only the tail chunk retained, got %d chunks", len(chunks))
	}
}

func TestChatBufferStore(t *testing.T) {
	s := &ChatBufferStore{m: make(map[string]*chatBuffer)} // no janitor goroutine
	key := chatBufferKey("u1", "n1", "42")
	if s.get(key) != nil {
		t.Fatal("expected no buffer initially")
	}
	b := s.start(key, nil, "req-1")
	if s.get(key) != b {
		t.Fatal("start did not register the buffer")
	}
	// A new turn for the same chat supersedes the previous buffer.
	b2 := s.start(key, nil, "req-2")
	if s.get(key) != b2 || b2 == b {
		t.Fatal("start should replace the existing buffer")
	}
	s.remove(key)
	if s.get(key) != nil {
		t.Fatal("remove did not drop the buffer")
	}
}

func TestChatBufferPreservesOpaqueEncryptionHeaders(t *testing.T) {
	b := newChatBuffer(nil, "req-1", time.Now())
	b.setEncryptionHeaders("v1", "request-binding", "sse", "text/event-stream")
	version, context, framing, innerContentType := b.encryptionHeaders()
	if version != "v1" || context != "request-binding" || framing != "sse" || innerContentType != "text/event-stream" {
		t.Fatalf("unexpected encryption metadata: %q %q %q %q", version, context, framing, innerContentType)
	}
}

func flatten(chunks [][]byte) string {
	var b bytes.Buffer
	for _, c := range chunks {
		b.Write(c)
	}
	return b.String()
}
