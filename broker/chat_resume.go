package main

import (
	"net/http"
	"time"
)

// handleChatResume replays a buffered chat turn so a web/mobile client can rejoin a
// stream after its connection dropped. It serves the recorded UI-message chunks from
// the start and then tails any further output until the turn ends — the AI SDK
// reconciles chunks by message/part id, so a full replay produces no duplicates.
//
// GET /u/{uid}/n/{nid}/api/ai/chat/resume/{chatId}
//   - buffer present → 200 + the (continuing) event stream
//   - buffer absent/expired → 204 (the SDK treats this as "nothing to resume" and
//     the client falls back to reloading chat history)
func (s *Server) handleChatResume(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	nid := r.PathValue("nid")
	chatID := r.PathValue("chatId")

	claims, err := s.requireAccess(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if claims.Subject != uid {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	buf := s.chatBufs.get(chatBufferKey(uid, nid, chatID))
	if buf == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Mirror the headers a live UI-message-stream response carries.
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	h.Set("x-vercel-ai-ui-message-stream", "v1")
	if version, context, framing, innerContentType := buf.encryptionHeaders(); version != "" {
		h.Set("X-Operon-E2EE", version)
		h.Set("X-Operon-E2EE-Context", context)
		h.Set("X-Operon-E2EE-Framing", framing)
		h.Set("X-Operon-Inner-Content-Type", innerContentType)
		if framing == "ndjson" {
			h.Set("Content-Type", "application/x-ndjson")
		}
	}
	h.Set("X-Chat-Id", chatID)
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)
	flush(flusher)

	idx := 0
	// Keepalive: a resumed turn that's still running can tail-idle just like a live
	// one, so hold the connection open with SSE comments during gaps (see
	// streamKeepaliveInterval in http_proxy.go).
	keepalive := time.NewTicker(streamKeepaliveInterval)
	defer keepalive.Stop()
	for {
		chunks, next, done, wait := buf.snapshotFrom(idx)
		idx = next
		for _, c := range chunks {
			if _, err := w.Write(c); err != nil {
				return // resume client went away again
			}
		}
		flush(flusher)
		if done {
			return
		}
		select {
		case <-wait:
			// new data or the turn ended → loop and drain
		case <-keepalive.C:
			if _, err := w.Write(sseKeepalive); err != nil {
				return
			}
			flush(flusher)
		case <-r.Context().Done():
			return
		}
	}
}

// handleChatCancel is the explicit user-stop path. The web client routes a real
// "stop" here (separate from a network drop) so the node actually aborts generation,
// and the buffer is dropped. A network drop deliberately does NOT hit this endpoint —
// it goes through resume instead.
//
// POST /u/{uid}/n/{nid}/api/ai/chat/cancel/{chatId}
func (s *Server) handleChatCancel(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	nid := r.PathValue("nid")
	chatID := r.PathValue("chatId")

	claims, err := s.requireAccess(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	if claims.Subject != uid {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	key := chatBufferKey(uid, nid, chatID)
	if buf := s.chatBufs.get(key); buf != nil {
		if conn, reqID := buf.cancelTarget(); conn != nil && reqID != "" {
			conn.cancelRequest(reqID, "user_cancelled")
		}
		s.chatBufs.remove(key)
	}
	w.WriteHeader(http.StatusNoContent)
}
