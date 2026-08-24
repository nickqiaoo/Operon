package main

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestWithCORSAllowsConfiguredOrigin(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	called := false
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "http://broker/auth/refresh", nil)
	req.Header.Set("Origin", "https://app.example.test")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if !called {
		t.Fatal("handler was not called for allowed origin")
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.test" {
		t.Fatalf("allow origin = %q, want configured origin", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("allow credentials = %q, want true", got)
	}
}

func TestWithCORSRejectsUnexpectedOrigin(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	called := false
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "http://broker/auth/refresh", nil)
	req.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if called {
		t.Fatal("handler should not be called for rejected origin")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusForbidden)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("rejected origin should not get CORS allow header, got %q", got)
	}
}

// Apple posts the sign-in result cross-site, so the request carries
// `Origin: https://appleid.apple.com` — an origin that by design is not in the
// allowlist. Before the exemption this middleware answered 403 and the handler
// never ran, which killed every Apple sign-in with a message visible only in the
// user's browser.
func TestWithCORSLetsAppleFormPostThrough(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	called := false
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "http://broker/auth/apple/callback", nil)
	req.Header.Set("Origin", "https://appleid.apple.com")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if !called {
		t.Fatal("apple form_post callback must reach the handler despite its origin")
	}
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusNoContent)
	}
}

// The exemption is one exact path, not a prefix — everything else still gets the
// allowlist, including anything that merely looks Apple-adjacent.
func TestWithCORSExemptionIsScopedToTheCallbackPath(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	for _, path := range []string{"/auth/apple/callback/../refresh", "/auth/refresh", "/auth/apple/callbackx"} {
		called := false
		handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			called = true
			w.WriteHeader(http.StatusNoContent)
		}))
		req := httptest.NewRequest(http.MethodPost, "http://broker"+path, nil)
		req.Header.Set("Origin", "https://appleid.apple.com")
		w := httptest.NewRecorder()

		handler.ServeHTTP(w, req)

		if called || w.Code != http.StatusForbidden {
			t.Fatalf("%s: expected the allowlist to still apply, got called=%v status=%d", path, called, w.Code)
		}
	}
}

// The packaged app's web view reports `capacitor://localhost` — not
// `https://localhost`, whatever `server.iosScheme` says — so every request it
// made was rejected by the middleware before reaching a handler. The visible
// symptom was a sign-in that silently bounced back to the login screen.
func TestWithCORSAllowsThePackagedAppOrigin(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	called := false
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	// The preflight, which is where this actually failed in production.
	// withCORS answers OPTIONS itself, so the handler is not expected to run.
	preflight := httptest.NewRequest(http.MethodOptions, "http://broker/auth/token", nil)
	preflight.Header.Set("Origin", "capacitor://localhost")
	pw := httptest.NewRecorder()
	handler.ServeHTTP(pw, preflight)

	if pw.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want %d", pw.Code, http.StatusNoContent)
	}
	if got := pw.Header().Get("Access-Control-Allow-Origin"); got != "capacitor://localhost" {
		t.Fatalf("preflight allow origin = %q, want the app origin echoed back", got)
	}

	// And the request the preflight was clearing the way for.
	req := httptest.NewRequest(http.MethodPost, "http://broker/auth/token", nil)
	req.Header.Set("Origin", "capacitor://localhost")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if !called {
		t.Fatal("the packaged app's own origin must reach the handler")
	}
	if got := w.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("allow credentials = %q, want true", got)
	}
}

// Widening CORS must not widen where an authorization code may be sent.
func TestAppOriginIsNotARedirectTarget(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	if isAllowedRedirectURI("capacitor://localhost/auth/callback") {
		t.Fatal("the app origin must not become a valid redirect_uri; the native app uses operon://auth/callback")
	}
	if !isAllowedRedirectURI(nativeRedirectURI) {
		t.Fatal("the native redirect must still be allowed")
	}
}

// ai-sdk sets User-Agent on its chat request. WebKit forwards it (Chromium
// treats it as forbidden and drops it), so it shows up in the preflight — and a
// pinned Allow-Headers list that omitted it failed the preflight, which the
// packaged app surfaced only as "Load failed".
func TestPreflightEchoesRequestedHeaders(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodOptions, "http://broker/u/u1/n/n1/api/ai/chat", nil)
	req.Header.Set("Origin", "capacitor://localhost")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type,user-agent")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Headers"); got != "content-type,user-agent" {
		t.Fatalf("allow headers = %q, want the requested set echoed back", got)
	}
	// The response now varies on that request header, so it must say so or a
	// shared cache can serve one client's preflight answer to another.
	if vary := w.Header().Values("Vary"); !slices.Contains(vary, "Access-Control-Request-Headers") {
		t.Fatalf("Vary = %v, want it to include Access-Control-Request-Headers", vary)
	}
}

// With nothing requested, Authorization must still be advertised — `*` does not
// cover it, and every authenticated call depends on it.
func TestPreflightWithoutRequestedHeadersStillAllowsAuthorization(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	handler := withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodOptions, "http://broker/auth/nodes", nil)
	req.Header.Set("Origin", "capacitor://localhost")
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") {
		t.Fatalf("allow headers = %q, want Authorization", got)
	}
}

func TestLocalOriginsRemainAllowedForDev(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	if !isAllowedBrowserOrigin("http://localhost:5173") {
		t.Fatal("localhost dev origin should be allowed")
	}
	if !isAllowedBrowserOrigin("http://127.0.0.1:5173") {
		t.Fatal("127.0.0.1 dev origin should be allowed")
	}
}

func TestRedirectURIAllowlist(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	if !isAllowedRedirectURI("https://app.example.test/auth/callback") {
		t.Fatal("configured callback redirect should be allowed")
	}
	if !isAllowedRedirectURI("http://localhost:5173/auth/callback") {
		t.Fatal("localhost callback redirect should be allowed")
	}
	if isAllowedRedirectURI("https://app.example.test/other") {
		t.Fatal("wrong redirect path should be rejected")
	}
	if isAllowedRedirectURI("https://evil.example/auth/callback") {
		t.Fatal("unexpected redirect origin should be rejected")
	}
}
