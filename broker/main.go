// operon-broker — the cloud relay between the web client and on-machine agents.
//
// A transparent reverse proxy (one catch-all forwards any /api/* over a per-node
// SSE/streaming-POST tunnel) PLUS the identity service: GitHub/dev federated login,
// JWT issuance, JWKS, and account⇄node pairing. See docs/remote-tunnel/.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Server wires the registry (live agent conns), identity store (Postgres), token
// signer/verifier, and OAuth flows.
type Server struct {
	reg       *Registry
	store     *Store
	auth      *Auth
	oauth     *OAuth
	chatBufs  *ChatBufferStore
	conns     *ConnTable // live tunnels by connId, for uplink batch routing
	dir       *Directory // publishes node→owner routes for the front router (nil-safe)
	lifecycle *Lifecycle
	apns      *apnsConfig // nil when iOS push isn't configured
	fcm       *fcmConfig  // nil when Android push isn't configured
	reviewer  *reviewerConfig
}

func main() {
	// Structured JSON logs so Loki/Promtail can parse fields (user/node/conn/...).
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	addr := env("LISTEN_ADDR", ":8080")
	publicURL := env("PUBLIC_URL", "http://127.0.0.1:8080")
	dsn := env("DATABASE_URL", "postgres://operon:dev@127.0.0.1:5433/operon?sslmode=disable")
	keyPath := env("JWT_KEY_PATH", "broker-data/jwt-key.pem")

	if err := os.MkdirAll(filepath.Dir(keyPath), 0o700); err != nil {
		slog.Error("mkdir key dir", "err", err)
		os.Exit(1)
	}

	store, err := OpenStore(dsn)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	auth, err := NewAuth(keyPath)
	if err != nil {
		slog.Error("init auth", "err", err)
		os.Exit(1)
	}
	// Multi-instance wiring. REDIS_URL enables the shared directory (also used for
	// OAuth state); INSTANCE_ADDR is this instance's peer-reachable base URL (e.g.
	// http://10.0.0.3:8080) — the value published as the owner route for the front
	// router (OpenResty) to dial. Without both, the broker runs as a single instance.
	redisURL := os.Getenv("REDIS_URL")
	selfAddr := os.Getenv("INSTANCE_ADDR")
	rdb := openRedis(redisURL)
	if rdb != nil && selfAddr == "" {
		slog.Error("REDIS_URL set but INSTANCE_ADDR empty — directory disabled; set INSTANCE_ADDR to this instance's peer URL")
	}
	dir := &Directory{rdb: rdb, self: selfAddr}
	kv := newEphemeralKV(rdb)

	// A misconfigured Apple key disables that one provider rather than taking
	// the broker down — GitHub sign-in must keep working either way.
	apple, err := newAppleConfig(publicURL)
	if err != nil {
		slog.Error("sign in with apple disabled", "err", err)
	}
	oauth := NewOAuth(store, os.Getenv("GITHUB_CLIENT_ID"), os.Getenv("GITHUB_CLIENT_SECRET"), publicURL, kv, apple)

	apns, err := newAPNsConfig()
	if err != nil {
		slog.Error("ios push notifications disabled", "err", err)
	}
	fcm, err := newFCMConfig()
	if err != nil {
		slog.Error("android push notifications disabled", "err", err)
	}

	s := &Server{
		reg:       NewRegistry(),
		store:     store,
		auth:      auth,
		oauth:     oauth,
		chatBufs:  NewChatBufferStore(),
		conns:     NewConnTable(),
		dir:       dir,
		lifecycle: NewLifecycle(dir, os.Getenv("ADMIN_TOKEN")),
		apns:      apns,
		fcm:       fcm,
		reviewer:  newReviewerConfig(),
	}
	if s.reviewer != nil {
		// Worth one line at startup: it is a password door into a real account,
		// and "is it still enabled?" should be answerable from the log. The
		// names are listed because configuring a second account is easy to get
		// half-right — a pair with a missing password is skipped in silence.
		slog.Info("review sign-in enabled", "usernames", strings.Join(s.reviewer.usernames(), ","))
	}
	if dir.enabled() {
		slog.Info("broker: multi-instance mode (publishing routes for front router)", "self", selfAddr)
	}
	go s.runDrainLoop(context.Background())

	reg := registerMetrics(s)

	mux := http.NewServeMux()
	mux.Handle("GET /metrics", metricsHandler(reg))
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /ready", s.handleReady)
	mux.HandleFunc("GET /admin/status", s.handleAdminStatus)
	mux.HandleFunc("POST /admin/drain", s.handleAdminDrain)
	mux.HandleFunc("POST /admin/undrain", s.handleAdminUndrain)

	// Identity
	mux.HandleFunc("GET /.well-known/jwks.json", s.handleJWKS)
	mux.HandleFunc("GET /auth/authorize", s.handleAuthorize)
	mux.HandleFunc("GET /auth/github/callback", s.handleGitHubCallback)
	mux.HandleFunc("POST /auth/apple/callback", s.handleAppleCallback)
	mux.HandleFunc("POST /auth/review", s.handleReviewerLogin)
	mux.HandleFunc("POST /auth/token", s.handleToken)
	mux.HandleFunc("POST /auth/refresh", s.handleRefresh)
	mux.HandleFunc("POST /auth/logout", s.handleLogout)
	mux.HandleFunc("POST /auth/nodes", s.handleCreateNode)
	mux.HandleFunc("GET /auth/nodes", s.handleListUserNodes)
	mux.HandleFunc("DELETE /auth/nodes/{id}", s.handleRevokeNode)
	mux.HandleFunc("DELETE /auth/account", s.handleDeleteAccount)
	mux.HandleFunc("POST /auth/push/devices", s.handleRegisterPushDevice)
	mux.HandleFunc("DELETE /auth/push/devices", s.handleDeletePushDevice)

	// Tunnel — node leg is an SSE downlink + discrete batched POSTs for the uplink
	// (proxy- and CDN-friendly; neither a WS upgrade nor an endless request body).
	mux.HandleFunc("GET /agent/down", s.handleAgentDown)
	mux.HandleFunc("POST /agent/up", s.handleAgentUp)
	mux.HandleFunc("POST /agent/push", s.handleAgentPush)
	// Stream resilience (web/mobile): resume replays a buffered chat turn after a
	// dropped connection; cancel is the explicit user-stop path. Registered before
	// the catch-all — these literal patterns are more specific, so ServeMux routes
	// them here and everything else falls through to handleProxy.
	mux.HandleFunc("GET /u/{uid}/n/{nid}/api/ai/chat/resume/{chatId}", s.handleChatResume)
	mux.HandleFunc("POST /u/{uid}/n/{nid}/api/ai/chat/cancel/{chatId}", s.handleChatCancel)
	mux.HandleFunc("/u/{uid}/n/{nid}/api/{rest...}", s.handleProxy)

	slog.Info("operon broker listening", "addr", addr, "publicURL", publicURL)
	if err := http.ListenAndServe(addr, withCORS(withMetrics(mux))); err != nil {
		slog.Error("broker exited", "err", err)
		os.Exit(1)
	}
}

// withCORS lets the browser-hosted web client (a different origin) call the broker.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Apple returns the sign-in result as a cross-site form POST
		// (`response_mode=form_post`), so the browser attaches
		// `Origin: https://appleid.apple.com`. That origin can never be in the
		// allowlist, and the allowlist is the wrong control here anyway: this is
		// a top-level navigation, not an XHR, so the response is never exposed
		// to whoever posted it. What actually defends this endpoint is `state`,
		// verified in handleAppleCallback. Without this exemption every Apple
		// sign-in dies at the middleware with 403 "origin not allowed", before
		// the handler runs — and the only place it is visible is the user's
		// browser, since the broker logs nothing for a rejected origin.
		if r.URL.Path == "/auth/apple/callback" {
			next.ServeHTTP(w, r)
			return
		}
		origin := r.Header.Get("Origin")
		h := w.Header()
		if origin != "" {
			if !isAllowedRequestOrigin(origin) {
				h.Add("Vary", "Origin")
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin not allowed"})
				return
			}
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
		} else {
			h.Set("Access-Control-Allow-Origin", "*")
		}
		h.Add("Vary", "Origin")
		h.Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		// Echo back whatever the preflight asks for, rather than pinning a list.
		//
		// This sits in front of an evolving API and of client libraries we do not
		// control, so a fixed list turns every newly-sent header into a CORS
		// failure. It already happened once: ai-sdk sets `User-Agent` on its chat
		// request, WebKit (unlike Chromium) does not treat that as a forbidden
		// header and so includes it in the preflight, the pinned list did not
		// cover it, and chat died with `Load failed` in the packaged app while
		// working perfectly in every browser.
		//
		// Not a loosening of anything that matters: Allow-Headers is not an
		// access control, it is a declaration. The request still has to carry a
		// valid token, and `sanitizeReqHeaders` strips Authorization before
		// anything reaches the node.
		if requested := r.Header.Get("Access-Control-Request-Headers"); requested != "" {
			h.Add("Vary", "Access-Control-Request-Headers")
			h.Set("Access-Control-Allow-Headers", requested)
		} else {
			// Authorization must be listed explicitly — `*` does NOT cover it.
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Admin-Token")
		}
		// X-Turn-Id identifies the live turn a chat response belongs to; the web
		// client reads it to tell its own turn from a peer's, so it must be
		// exposed or the header is invisible to JS. Keep in sync with the node's
		// cors() exposeHeaders in server/src/app.ts.
		h.Set("Access-Control-Expose-Headers", "X-Chat-Id, X-Turn-Id, X-Operon-Error-Code, X-Operon-E2EE, X-Operon-E2EE-Context, X-Operon-E2EE-Framing, X-Operon-Inner-Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

var defaultBrowserOrigins = []string{
	"https://app.operon.chatcode.top",
	"https://app.operon.teslawrap.top",
	"https://operon-app.pages.dev",
}

// nativeAppOrigin is the origin the packaged app's web view actually reports.
//
// Capacitor serves the bundle from a custom scheme, and `server.iosScheme:
// 'https'` does NOT change that however plausible it looks in the config:
// WKWebView refuses a scheme handler for http/https (they are handled
// internally), so Capacitor silently keeps `capacitor://`. Every request the app
// makes therefore carries `Origin: capacitor://localhost`, which failed the
// allowlist — and since the rejection happens in middleware, the broker logged
// nothing and the app just bounced back to the login screen.
//
// Allowing it costs nothing: an origin allowlist only ever constrains *browsers*,
// which are the things that both attach Origin faithfully and refuse to hand the
// response to script without permission. A native client is not bound by either —
// it can simply omit the header, which already takes the `origin == ""` path
// above. What actually authenticates these endpoints is PKCE and the bearer
// token, not this string.
const nativeAppOrigin = "capacitor://localhost"

// nativeRedirectURI is where the broker sends the packaged iOS app back to.
// GitHub and Apple can only redirect to an http(s) URL, so the broker takes
// their callback itself and then redirects to this custom scheme, which iOS
// routes to the app.
//
// Exact-match on purpose. A prefix or host-wildcard match on a custom scheme is
// how open redirects get built, and there is only ever one native client.
const nativeRedirectURI = "operon://auth/callback"

func isAllowedRedirectURI(raw string) bool {
	// Note this is deliberately checked before the http(s) parse below, and that
	// `isLocalRedirectURI` stays false for it — so `handleAuthorize` keeps
	// requiring a PKCE challenge for every native sign-in.
	if raw == nativeRedirectURI {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Path != "/auth/callback" {
		return false
	}
	return isAllowedBrowserOrigin(originFromURL(u))
}

func isLocalRedirectURI(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && isLocalBrowserURL(u)
}

// isAllowedRequestOrigin gates the CORS middleware. Wider than
// isAllowedBrowserOrigin by exactly one entry — the packaged app's own web view —
// which deliberately does NOT widen the redirect_uri allowlist that
// isAllowedBrowserOrigin also feeds.
func isAllowedRequestOrigin(origin string) bool {
	return origin == nativeAppOrigin || isAllowedBrowserOrigin(origin)
}

func isAllowedBrowserOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	if isLocalBrowserURL(u) {
		return true
	}
	normalized := originFromURL(u)
	for _, allowed := range configuredBrowserOrigins() {
		if normalized == allowed {
			return true
		}
	}
	return false
}

func configuredBrowserOrigins() []string {
	raw := strings.TrimSpace(os.Getenv("WEB_ORIGINS"))
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS"))
	}
	values := defaultBrowserOrigins
	if raw != "" {
		values = strings.Split(raw, ",")
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		u, err := url.Parse(strings.TrimSpace(value))
		if err != nil || u.Scheme == "" || u.Host == "" {
			continue
		}
		origin := originFromURL(u)
		if _, ok := seen[origin]; ok {
			continue
		}
		seen[origin] = struct{}{}
		out = append(out, origin)
	}
	return out
}

func isLocalBrowserURL(u *url.URL) bool {
	host := u.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

func originFromURL(u *url.URL) string {
	return u.Scheme + "://" + u.Host
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
