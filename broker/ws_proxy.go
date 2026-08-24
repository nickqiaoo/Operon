package main

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/coder/websocket"
)

// bearerSubprotocolPrefix carries the access token through the WS handshake. The
// browser WebSocket API cannot set an Authorization header, so the web client sends
// the token as a subprotocol: `Sec-WebSocket-Protocol: operon.bearer.<jwt>`. The
// broker authenticates from it, then echoes the same subprotocol back so the
// handshake completes (browsers fail the open if the server selects none).
const bearerSubprotocolPrefix = "operon.bearer."

// isWebSocketUpgrade reports whether r is a WebSocket handshake (so handleProxy
// branches to the raw-WS tunnel instead of the HTTP request bridge).
func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// handleWSProxy tunnels a browser WebSocket (e.g. /api/terminal/ws) to the addressed
// agent's local backend over the agent's existing connection. The browser WS becomes
// a logical stream keyed by a fresh request id; ws-open / ws-msg / ws-close frames
// carry it. See protocol §2.7.
func (s *Server) handleWSProxy(w http.ResponseWriter, r *http.Request, uid, nid, rest string) {
	// Auth: the token rides in the Sec-WebSocket-Protocol subprotocol (browsers can't
	// set Authorization on a WS). Same multi-tenant gate as the HTTP path: the token's
	// user must equal the path user.
	subproto, token := bearerFromSubprotocols(r.Header.Get("Sec-WebSocket-Protocol"))
	if token == "" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	claims, err := s.auth.verify(token)
	if err != nil || claims.Typ != "access" {
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

	bws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Browser origin differs from the broker; we authenticate via the token, not
		// the Origin. Echo the bearer subprotocol so the handshake completes.
		InsecureSkipVerify: true,
		Subprotocols:       []string{subproto},
	})
	if err != nil {
		return
	}
	bws.SetReadLimit(16 << 20)
	defer bws.CloseNow()

	id := conn.nextID()
	path := "/api/" + rest
	query := ""
	if r.URL.RawQuery != "" {
		query = "?" + r.URL.RawQuery
	}

	// Bind the stream to a cancelable context so either pump direction (or the agent
	// connection dying) tears the whole thing down.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	st := conn.openWS(ctx, id, path, query, sanitizeWSHeaders(r.Header))
	slog.Debug("broker: ws tunnel open", "user", uid, "node", nid, "id", id, "path", path)
	defer conn.closeWS(id, int(websocket.StatusNormalClosure), "")

	// browser → agent: read browser frames, forward as ws-msg.
	go func() {
		defer cancel()
		for {
			_, data, err := bws.Read(ctx)
			if err != nil {
				return
			}
			conn.sendWSMsg(id, data)
		}
	}()

	// agent → browser: drain stream events, write to the browser WS. Single writer.
	for {
		select {
		case ev := <-st.events:
			switch ev.kind {
			case wsEvAck:
				if !ev.ok {
					bws.Close(websocket.StatusBadGateway, "agent rejected ws")
					return
				}
			case wsEvMsg:
				if err := bws.Write(ctx, websocket.MessageText, ev.data); err != nil {
					return
				}
			case wsEvClose:
				code := websocket.StatusCode(ev.wsCode)
				if code == 0 {
					code = websocket.StatusNormalClosure
				}
				bws.Close(code, truncateReason(ev.reason))
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// sanitizeWSHeaders is sanitizeReqHeaders plus dropping the WS handshake headers —
// in particular Sec-WebSocket-Protocol, which carries the bearer token and must not
// be forwarded to the agent (the agent dials the local WS itself and ignores these).
func sanitizeWSHeaders(h http.Header) map[string][]string {
	out := sanitizeReqHeaders(h)
	for k := range out {
		if strings.HasPrefix(k, "sec-websocket") {
			delete(out, k)
		}
	}
	return out
}

// bearerFromSubprotocols scans the comma-separated Sec-WebSocket-Protocol header for
// the `operon.bearer.<token>` entry and returns (fullSubprotocol, token). The full
// value must be echoed back verbatim on Accept.
func bearerFromSubprotocols(header string) (subproto, token string) {
	for _, p := range strings.Split(header, ",") {
		p = strings.TrimSpace(p)
		if strings.HasPrefix(p, bearerSubprotocolPrefix) {
			return p, strings.TrimPrefix(p, bearerSubprotocolPrefix)
		}
	}
	return "", ""
}

// truncateReason keeps WS close reasons within the 123-byte protocol limit.
func truncateReason(s string) string {
	if len(s) > 123 {
		return s[:123]
	}
	return s
}
