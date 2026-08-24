package main

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestTokenExpiryShape(t *testing.T) {
	auth, err := NewAuth(filepath.Join(t.TempDir(), "jwt-key.pem"))
	if err != nil {
		t.Fatalf("NewAuth: %v", err)
	}

	access, err := auth.signAccess("user-1")
	if err != nil {
		t.Fatalf("signAccess: %v", err)
	}
	accessClaims, err := auth.verify(access)
	if err != nil {
		t.Fatalf("verify access: %v", err)
	}
	if accessClaims.ExpiresAt == nil {
		t.Fatal("access token should expire")
	}
	ttl := time.Until(accessClaims.ExpiresAt.Time)
	if ttl <= 0 || ttl > accessTTL+time.Minute {
		t.Fatalf("unexpected access token ttl: %s", ttl)
	}

	node, err := auth.signNode("user-1", "node-1")
	if err != nil {
		t.Fatalf("signNode: %v", err)
	}
	nodeClaims, err := auth.verify(node)
	if err != nil {
		t.Fatalf("verify node: %v", err)
	}
	if nodeClaims.ExpiresAt != nil {
		t.Fatal("node token should not expire by time")
	}
}

func TestVerifyExpiryByTokenType(t *testing.T) {
	auth, err := NewAuth(filepath.Join(t.TempDir(), "jwt-key.pem"))
	if err != nil {
		t.Fatalf("NewAuth: %v", err)
	}
	expired := jwt.NewNumericDate(time.Now().Add(-time.Hour))

	expiredAccess, err := auth.sign(Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "user-1",
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)),
			ExpiresAt: expired,
		},
		Typ: "access",
	})
	if err != nil {
		t.Fatalf("sign expired access: %v", err)
	}
	if _, err := auth.verify(expiredAccess); err == nil {
		t.Fatal("expired access token should be rejected")
	}

	oldNode, err := auth.sign(Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "user-1",
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-8 * 24 * time.Hour)),
			ExpiresAt: expired,
		},
		Typ:    "node",
		NodeID: "node-1",
	})
	if err != nil {
		t.Fatalf("sign old node: %v", err)
	}
	if _, err := auth.verify(oldNode); err != nil {
		t.Fatalf("expired node token should still verify: %v", err)
	}
}
