package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// streamKeepaliveInterval bounds how long a tunneled stream may sit byte-idle
// before the broker injects an SSE comment. Idle response connections get
// closed by intermediaries (reverse proxies, CDNs, carrier NAT) — commonly at
// 30–60s — which surfaces to the browser as a failed fetch ("Load failed").
// A long agent turn (e.g. a slow tool run mid-stream) is exactly such a gap.
const streamKeepaliveInterval = 15 * time.Second

// sseKeepalive is a comment line: valid SSE the stream parser ignores, so it
// keeps the connection warm without perturbing the UI-message stream.
var sseKeepalive = []byte(": keepalive\n\n")

// handleProxy is THE catch-all that makes the transparent tunnel work: it forwards
// ANY /u/<uid>/n/<nid>/api/<rest...> request to the addressed agent and streams the
// response back. It is path-agnostic — adding endpoints to the app changes nothing
// here. See protocol §2.2–§2.5.
func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	nid := r.PathValue("nid")
	rest := r.PathValue("rest")

	// WebSocket upgrades (e.g. /api/terminal/ws) take the raw-WS tunnel, which auths
	// via the Sec-WebSocket-Protocol subprotocol instead of the Authorization header.
	if isWebSocketUpgrade(r) {
		s.handleWSProxy(w, r, uid, nid, rest)
		return
	}

	// Multi-tenant gate: the caller must present a valid access token whose user ==
	// the path user. This is the isolation boundary — without it one user could
	// address another user's node (fs/git/agent-grade power). Preflight OPTIONS is
	// short-circuited by withCORS before reaching here.
	claims, err := s.requireAccess(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if claims.Subject != uid {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}
	if s.lifecycle.IsDraining() {
		writeServerDraining(w)
		return
	}

	conn, ok := s.reg.Get(uid, nid)
	if !ok {
		writeNodeOffline(w)
		return
	}

	path := "/api/" + rest
	query := ""
	if r.URL.RawQuery != "" {
		query = "?" + r.URL.RawQuery
	}

	var body, enc string
	if r.Body != nil {
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			body, enc = encodeBytes(b)
		}
	}

	id := conn.nextID()
	p := conn.startRequest(&Frame{
		T:       FrameReq,
		ID:      id,
		Method:  r.Method,
		Path:    path,
		Query:   query,
		Headers: sanitizeReqHeaders(r.Header),
		Body:    body,
		Enc:     enc,
	})

	flusher, _ := w.(http.Flusher)
	headWritten := false
	// isEventStream gates keepalives: only inject into SSE responses, where a
	// comment line is a safe no-op. JSON/binary responses finish promptly and
	// must not have stray bytes spliced in.
	isEventStream := false

	// Fixed-cadence keepalive; the comment is a no-op even if it lands between
	// real chunks, so a ticker (vs a per-write reset timer) is simplest and safe.
	keepalive := time.NewTicker(streamKeepaliveInterval)
	defer keepalive.Stop()

	// buf is non-nil once we see an X-Chat-Id response header, marking this as an
	// agent chat stream worth buffering for resume. handoff means a drain goroutine
	// took over (browser left mid-turn) and owns p.cancel().
	var buf *chatBuffer
	handoff := false
	defer func() {
		if !handoff {
			p.cancel()
		}
	}()

	for {
		select {
		case ev := <-p.events:
			switch ev.kind {
			case evHead:
				writeHead(w, ev.frame)
				headWritten = true
				flush(flusher)
				isEventStream = strings.Contains(
					strings.ToLower(headerValue(ev.frame.Headers, "Content-Type")),
					"text/event-stream",
				)
				if cid := headerValue(ev.frame.Headers, "X-Chat-Id"); cid != "" {
					buf = s.chatBufs.start(chatBufferKey(uid, nid, cid), conn, id)
					buf.setEncryptionHeaders(
						headerValue(ev.frame.Headers, "X-Operon-E2EE"),
						headerValue(ev.frame.Headers, "X-Operon-E2EE-Context"),
						headerValue(ev.frame.Headers, "X-Operon-E2EE-Framing"),
						headerValue(ev.frame.Headers, "X-Operon-Inner-Content-Type"),
					)
				}
			case evChunk:
				if !headWritten {
					w.WriteHeader(http.StatusOK)
					headWritten = true
				}
				if buf != nil {
					buf.append(ev.data)
				}
				_, _ = w.Write(ev.data)
				flush(flusher) // flush every chunk or SSE buffers until the end
			case evEnd:
				if buf != nil {
					buf.finish()
				}
				return
			case evError:
				if buf != nil {
					buf.finish()
				}
				if !headWritten {
					status := ev.frame.Status
					if status == 0 {
						status = http.StatusBadGateway
					}
					http.Error(w, fmt.Sprintf(`{"error":%q}`, ev.frame.Code), status)
				}
				// mid-stream error: head already sent, just stop (truncated stream)
				return
			}
		case <-keepalive.C:
			// Nudge the connection so idle intermediaries don't drop it mid-turn.
			// Only SSE streams (headers seen, event-stream) get the comment; the
			// buffer is NOT fed it — resume replays only real chunks.
			if headWritten && isEventStream {
				if _, err := w.Write(sseKeepalive); err != nil {
					return
				}
				flush(flusher)
			}
		case <-p.ctx.Done():
			// The tunnel died under us (node reconnecting, instance draining, …), so no
			// further chunks are coming. Without this case the handler would sit here
			// forever — silently for a plain request, or emitting keepalives into an SSE
			// stream that never ends. The node's local turn is unaffected and keeps
			// running (server/src/routes/ai.ts deliberately ignores the request signal),
			// so a chat client recovers the rest through resume.
			if buf != nil {
				buf.finish()
			}
			if !headWritten {
				writeNodeOffline(w)
			}
			return
		case <-r.Context().Done():
			// Browser disconnected. For a chat stream, DON'T cancel the node — keep
			// draining its output into the buffer so the client can resume. Any other
			// request is best cancelled to stop the agent's local work.
			if buf != nil {
				handoff = true
				go drainToBuffer(p, buf)
				return
			}
			conn.cancelRequest(id, "client_disconnected")
			return
		}
	}
}

// drainToBuffer continues consuming a tunneled response after the browser has gone,
// recording chunks for a later resume. It owns p.cancel() once the handler hands off.
func drainToBuffer(p *pendingReq, buf *chatBuffer) {
	defer p.cancel()
	for {
		select {
		case ev := <-p.events:
			switch ev.kind {
			case evChunk:
				buf.append(ev.data)
			case evEnd, evError:
				buf.finish()
				return
			case evHead:
				// already past the head; ignore
			}
		case <-p.ctx.Done():
			// connection died → no more chunks are coming; let resume tailers stop.
			buf.finish()
			return
		}
	}
}

// headerValue does a case-insensitive lookup (tunneled headers may be normalized to
// any case) and returns the first value.
func headerValue(h map[string][]string, key string) string {
	for k, vals := range h {
		if strings.EqualFold(k, key) && len(vals) > 0 {
			return vals[0]
		}
	}
	return ""
}

func flush(f http.Flusher) {
	if f != nil {
		f.Flush()
	}
}

// writeHead copies the agent's response head to the browser response, dropping
// headers the broker manages or that don't survive proxying.
func writeHead(w http.ResponseWriter, f *Frame) {
	for k, vals := range f.Headers {
		if isHopByHop(k) ||
			strings.EqualFold(k, "content-length") ||
			strings.HasPrefix(strings.ToLower(k), "access-control-") {
			continue
		}
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	status := f.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
}

// sanitizeReqHeaders strips hop-by-hop headers, the inbound Host, and Content-Length
// (the agent's fetch sets its own) before forwarding to localhost. Phase 2 also
// strips the broker session credential here.
func sanitizeReqHeaders(h http.Header) map[string][]string {
	out := make(map[string][]string, len(h))
	for k, vals := range h {
		lk := strings.ToLower(k)
		// Strip the broker session credential — the local backend trusts localhost
		// and must never receive the browser's broker token.
		if isHopByHop(lk) || lk == "host" || lk == "content-length" || lk == "authorization" {
			continue
		}
		cp := make([]string, len(vals))
		copy(cp, vals)
		out[lk] = cp
	}
	return out
}

func isHopByHop(k string) bool {
	switch strings.ToLower(k) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"te", "trailer", "transfer-encoding", "upgrade":
		return true
	}
	return false
}
