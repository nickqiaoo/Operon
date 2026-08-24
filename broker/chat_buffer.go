package main

import (
	"sync"
	"time"
)

// chat_buffer.go implements the broker-side resilience for web/mobile agent
// streams. When the web client tunnels POST /api/ai/chat, the node streams the
// UI-message SSE response back; the broker forwards it AND records the raw chunk
// bytes here, keyed by (uid, nid, chatId). If the browser disconnects mid-turn we
// keep draining the node into the buffer instead of cancelling, so a later
// GET …/ai/chat/resume/<chatId> can replay the whole stream (and tail the rest if
// the turn is still running). The AI SDK reconciles UIMessageChunks by message/part
// id, so a full replay produces no duplicates on the client.
//
// Everything here is broker-local: the node, the agent providers, and the desktop
// front-end are untouched. State is in-memory (single instance); a Redis-backed
// variant can replace ChatBufferStore wholesale if the broker is ever scaled out.

const (
	// chatBufferTTL is how long a finished buffer is kept so a reconnecting client
	// can still replay it (e.g. the turn completed while the phone was offline).
	chatBufferTTL = 10 * time.Minute
	// chatBufferIdleTTL bounds an abandoned in-flight buffer (node never ended,
	// client never came back) so memory can't grow without limit.
	chatBufferIdleTTL = 30 * time.Minute
	// chatBufferMaxBytes caps a single turn's buffered bytes. A turn larger than
	// this is still streamed live to a connected client, but resume only replays
	// the tail beyond the cap — better a partial replay than unbounded memory.
	chatBufferMaxBytes = 32 * 1024 * 1024
)

// chatBuffer accumulates one turn's response chunks and lets readers tail it.
type chatBuffer struct {
	mu               sync.Mutex
	chunks           [][]byte
	bytes            int
	done             bool          // node sent end (or the request errored/was cancelled)
	notify           chan struct{} // closed+replaced on every append/finish to wake tailers
	conn             *AgentConn    // owner connection, for the cancel endpoint
	reqID            string        // in-flight request id on conn, for the cancel endpoint
	updated          time.Time
	e2eeVersion      string
	e2eeContext      string
	e2eeFraming      string
	innerContentType string
}

func (b *chatBuffer) setEncryptionHeaders(version, context, framing, innerContentType string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.e2eeVersion = version
	b.e2eeContext = context
	b.e2eeFraming = framing
	b.innerContentType = innerContentType
}

func (b *chatBuffer) encryptionHeaders() (version, context, framing, innerContentType string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.e2eeVersion, b.e2eeContext, b.e2eeFraming, b.innerContentType
}

func newChatBuffer(conn *AgentConn, reqID string, now time.Time) *chatBuffer {
	return &chatBuffer{
		notify:  make(chan struct{}),
		conn:    conn,
		reqID:   reqID,
		updated: now,
	}
}

// wake signals all current tailers that there is new data or the stream ended.
// Caller must hold b.mu.
func (b *chatBuffer) wake() {
	close(b.notify)
	b.notify = make(chan struct{})
}

// append records one response chunk (a copy — the caller reuses its buffer).
func (b *chatBuffer) append(data []byte) {
	if len(data) == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.done {
		return
	}
	// Bound memory: once over the cap, drop the oldest chunks. Resume then replays
	// only the retained tail; the SDK still reconciles by id, it just won't have the
	// very start of a pathologically large turn.
	cp := make([]byte, len(data))
	copy(cp, data)
	b.chunks = append(b.chunks, cp)
	b.bytes += len(cp)
	for b.bytes > chatBufferMaxBytes && len(b.chunks) > 1 {
		b.bytes -= len(b.chunks[0])
		b.chunks = b.chunks[1:]
	}
	b.updated = time.Now()
	b.wake()
}

// finish marks the turn complete; tailers drain the rest and then stop.
func (b *chatBuffer) finish() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.done {
		return
	}
	b.done = true
	b.updated = time.Now()
	b.wake()
}

// snapshotFrom returns chunks at/after idx, whether the turn is done, and the
// notify channel to wait on for more. Readers loop: drain returned chunks, return
// if done, else block on the channel.
func (b *chatBuffer) snapshotFrom(idx int) (out [][]byte, next int, done bool, wait chan struct{}) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if idx < len(b.chunks) {
		out = make([][]byte, len(b.chunks)-idx)
		copy(out, b.chunks[idx:])
	}
	return out, len(b.chunks), b.done, b.notify
}

func (b *chatBuffer) cancelTarget() (*AgentConn, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.conn, b.reqID
}

// ChatBufferStore is the broker-global table of live/recent chat buffers.
type ChatBufferStore struct {
	mu sync.Mutex
	m  map[string]*chatBuffer
}

func NewChatBufferStore() *ChatBufferStore {
	s := &ChatBufferStore{m: make(map[string]*chatBuffer)}
	go s.janitor()
	return s
}

// chatBufferKey namespaces by user+node because chatId (the node's local DB id) is
// only unique within one node.
func chatBufferKey(uid, nid, chatID string) string {
	return uid + "/" + nid + "/" + chatID
}

// start creates (or resets) the buffer for a new turn. A new POST for the same
// chatId supersedes the previous turn's buffer.
func (s *ChatBufferStore) start(key string, conn *AgentConn, reqID string) *chatBuffer {
	b := newChatBuffer(conn, reqID, time.Now())
	s.mu.Lock()
	s.m[key] = b
	s.mu.Unlock()
	return b
}

func (s *ChatBufferStore) get(key string) *chatBuffer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[key]
}

// remove drops a buffer (used by the cancel endpoint).
func (s *ChatBufferStore) remove(key string) {
	s.mu.Lock()
	delete(s.m, key)
	s.mu.Unlock()
}

// janitor evicts finished buffers past their TTL and abandoned in-flight buffers
// past the idle TTL, so memory tracks only recent/active turns.
func (s *ChatBufferStore) janitor() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		s.mu.Lock()
		for k, b := range s.m {
			b.mu.Lock()
			age := now.Sub(b.updated)
			expired := (b.done && age > chatBufferTTL) || age > chatBufferIdleTTL
			b.mu.Unlock()
			if expired {
				delete(s.m, k)
			}
		}
		s.mu.Unlock()
	}
}
