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
	for _, route := range []string{"delegations/catalog", "delegations/sessions/" + id + "/turn", "chat-history", "fs/read",
		"git/status", "terminal/ws", "projects/3/workspaces", "events", "attachments/abc", "remote-ish"} {
		for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
			if !nodeDelegationRoute(method, route) {
				t.Fatalf("node token cannot reach %s %s", method, route)
			}
		}
		if nodeDelegationRoute("OPTIONS", route) || nodeDelegationRoute("CONNECT", route) {
			t.Fatalf("incorrect method scope for %s", route)
		}
	}
	for _, route := range []string{"e2ee", "e2ee/devices", "E2EE/devices", "e2ee/pair/start", "e2ee/pair/session/" + id + "/approve",
		"saas/config", "remote/abc/fs/read", "delegations/local", "delegations/local/settings", "delegations/local/machines",
		"integrations/events/linear", "delegations/../e2ee/devices", "fs/../saas", "./e2ee", "/e2ee", "fs//read", "", "fs\\read"} {
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
		"/u/alice/n/source/api/delegations/catalog",
		"/u/alice/n/target/api/delegations/local/settings",
		"/u/alice/n/target/api/e2ee/devices",
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
