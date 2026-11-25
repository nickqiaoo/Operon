package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEnrollCodeShapeAndNormalization(t *testing.T) {
	code := newEnrollCode()
	if len(code) != 16 || strings.ToUpper(code) != code {
		t.Fatalf("unexpected code %q", code)
	}
	if newEnrollCode() == code {
		t.Fatal("codes repeat")
	}
	if got := normalizeEnrollCode(" abcd-efgh ijkl-mnop "); got != "ABCDEFGHIJKLMNOP" {
		t.Fatalf("normalize = %q", got)
	}
}

func TestEnrollCodeIsSingleUse(t *testing.T) {
	kv := newMemoryKV()
	ctx := context.Background()
	if err := kv.put(ctx, enrollKey("CODE"), "alice", time.Minute); err != nil {
		t.Fatal(err)
	}
	if user, ok, _ := kv.take(ctx, enrollKey("CODE")); !ok || user != "alice" {
		t.Fatalf("first take = %q %v", user, ok)
	}
	if _, ok, _ := kv.take(ctx, enrollKey("CODE")); ok {
		t.Fatal("a code redeemed twice")
	}
}

func TestEnrollRoutesRefuseWithoutTheRightCredential(t *testing.T) {
	auth, err := NewAuth(filepath.Join(t.TempDir(), "jwt.pem"))
	if err != nil {
		t.Fatal(err)
	}
	access, err := auth.signAccess("alice")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{auth: auth, oauth: &OAuth{kv: newMemoryKV()}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/enroll", server.handleCreateEnrollCode)
	mux.HandleFunc("DELETE /agent/self", server.handleRevokeSelf)
	mux.HandleFunc("POST /auth/nodes/enroll/redeem", server.handleRedeemEnrollCode)

	// Minting and self-revocation take a node token: an access token, or none, is refused.
	for _, route := range [][2]string{{"POST", "/agent/enroll"}, {"DELETE", "/agent/self"}} {
		for _, bearer := range []string{"", access} {
			req := httptest.NewRequest(route[0], route[1], nil)
			if bearer != "" {
				req.Header.Set("Authorization", "Bearer "+bearer)
			}
			res := httptest.NewRecorder()
			mux.ServeHTTP(res, req)
			if res.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s (bearer=%v) = %d, want 401", route[0], route[1], bearer != "", res.Code)
			}
		}
	}

	// A code that was never issued, and an empty one.
	for _, body := range []string{`{"code":"AAAAAAAAAAAAAAAA","label":"box"}`, `{"code":""}`} {
		req := httptest.NewRequest("POST", "/auth/nodes/enroll/redeem", strings.NewReader(body))
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		if res.Code != http.StatusNotFound && res.Code != http.StatusBadRequest {
			t.Fatalf("redeem %s = %d", body, res.Code)
		}
		if !strings.Contains(res.Body.String(), "enroll_code_invalid") {
			t.Fatalf("redeem %s body = %s", body, res.Body.String())
		}
	}
}
