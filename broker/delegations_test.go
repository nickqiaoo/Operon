package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestDelegationNodeRouteScope(t *testing.T) {
	id := "12345678-1234-1234-1234-123456789012"
	allowed := map[string]string{
		"delegations/catalog":                      "GET",
		"delegations/providers/claude-code/models": "GET",
		"delegations/sessions/" + id + "/turn":     "POST",
		"delegations/sessions/" + id + "/control":  "POST",
	}
	for route, method := range allowed {
		if !nodeDelegationRoute(method, route) || nodeDelegationRoute("DELETE", route) {
			t.Fatalf("incorrect method scope for %s %s", method, route)
		}
	}
	for _, route := range []string{"chat-history", "fs/read", "terminal/ws", "e2ee/devices", "e2ee/pair/start", "e2ee/pair/claim", "e2ee/pair/status/" + id, "e2ee/pair/session/" + id + "/approve", "delegations/local/settings", "delegations/local/machines", "delegations/../fs/read",
		"delegations/sessions/not-a-uuid/turn", "delegations/providers/../models", "delegations/sessions/" + id + "/turn/x"} {
		if nodeDelegationRoute("GET", route) || nodeDelegationRoute("POST", route) {
			t.Fatalf("node token can reach %s", route)
		}
	}
}

func TestDelegationProxyRejectsForeignAndOutOfScopeNodeTokens(t *testing.T) {
	auth, err := NewAuth(filepath.Join(t.TempDir(), "jwt.pem"))
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.signNode("alice", "source")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{auth: auth}
	mux := http.NewServeMux()
	mux.HandleFunc("/u/{uid}/n/{nid}/api/{rest...}", server.handleProxy)
	for _, path := range []string{
		"/u/bob/n/target/api/delegations/catalog",
		"/u/alice/n/target/api/fs/read",
		"/u/alice/n/source/api/delegations/catalog",
		"/u/alice/n/target/api/delegations/local/settings",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		if res.Code != http.StatusForbidden {
			t.Fatalf("%s returned %d, want 403", path, res.Code)
		}
	}
}

func TestDelegationTunnelHeadersAreRemovedFromCallerInput(t *testing.T) {
	for _, header := range []string{delegationSourceHeader, delegationPublicKeyHeader, delegationSourceLabelHeader, "X-Operon-Delegation-Tunnel"} {
		headers := sanitizeReqHeaders(http.Header{strings.ToUpper(header): {"forged"}, "Content-Type": {"application/json"}})
		if _, ok := headers[strings.ToLower(header)]; ok || headers["content-type"][0] != "application/json" {
			t.Fatalf("failed to strip %s", header)
		}
	}
}

func TestDelegationPublicKeyRegistrationFormat(t *testing.T) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := base64.StdEncoding.EncodeToString(key.PublicKey().Bytes())
	if !validDelegationPublicKey(publicKey) || validDelegationPublicKey(publicKey+" ") || validDelegationPublicKey("invalid") ||
		validDelegationPublicKey(base64.StdEncoding.EncodeToString([]byte{1, 2, 3})) {
		t.Fatal("invalid delegation key validation")
	}
}
