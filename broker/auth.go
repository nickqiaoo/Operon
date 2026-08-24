package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Auth signs and verifies the broker's own JWTs and publishes the matching JWKS.
// Tokens come in two flavours (Typ): "access" (a logged-in user) and "node" (a
// paired device). The broker verifies both offline with its public key. See
// docs/remote-tunnel-auth.md.
type Auth struct {
	priv *rsa.PrivateKey
	kid  string
}

// Claims is the broker JWT body. Subject = userId.
type Claims struct {
	jwt.RegisteredClaims
	Typ    string `json:"typ"`              // "access" | "node"
	NodeID string `json:"nodeId,omitempty"` // set for node tokens
}

// 48h so a PWA reopened within a couple of days still has a valid access token
// in localStorage and skips /auth/refresh entirely — avoiding the rotation path
// that PWAs frequently break (they drop the rotated cookie, tripping reuse
// detection and revoking the whole session). Longer-lived bearer, softer logout.
const accessTTL = 48 * time.Hour

func NewAuth(keyPath string) (*Auth, error) {
	priv, err := loadOrCreateKey(keyPath)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	return &Auth{priv: priv, kid: hex.EncodeToString(sum[:8])}, nil
}

func loadOrCreateKey(path string) (*rsa.PrivateKey, error) {
	// Multi-instance: every broker must sign with the SAME key or tokens minted by
	// one are rejected by another. Prefer an injected key (env / secret manager);
	// fall back to a local file for single-instance dev.
	if pemStr := os.Getenv("JWT_PRIVATE_KEY_PEM"); pemStr != "" {
		block, _ := pem.Decode([]byte(pemStr))
		if block == nil {
			return nil, errors.New("invalid JWT_PRIVATE_KEY_PEM")
		}
		return x509.ParsePKCS1PrivateKey(block.Bytes)
	}
	if data, err := os.ReadFile(path); err == nil {
		block, _ := pem.Decode(data)
		if block == nil {
			return nil, errors.New("invalid key PEM")
		}
		return x509.ParsePKCS1PrivateKey(block.Bytes)
	}
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		return nil, err
	}
	return priv, nil
}

func (a *Auth) signAccess(userID string) (string, error) {
	return a.sign(Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(accessTTL)),
		},
		Typ: "access",
	})
}

// Node tokens intentionally do not expire by time. A node can still be revoked via
// the nodes table, and every tunnel connection checks revoked_at before going live.
func (a *Auth) signNode(userID, nodeID string) (string, error) {
	return a.sign(Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:  userID,
			IssuedAt: jwt.NewNumericDate(time.Now()),
		},
		Typ:    "node",
		NodeID: nodeID,
	})
}

func (a *Auth) sign(c Claims) (string, error) {
	t := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
	t.Header["kid"] = a.kid
	return t.SignedString(a.priv)
}

// verify parses + validates a broker JWT. Access tokens must have a live exp.
// Node tokens are time-unbounded; node revocation is checked against the DB.
func (a *Auth) verify(tokenStr string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, c, func(_ *jwt.Token) (interface{}, error) {
		return &a.priv.PublicKey, nil
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithoutClaimsValidation())
	if err != nil {
		return nil, err
	}
	if c.Typ == "access" {
		if c.ExpiresAt == nil {
			return nil, errors.New("access token missing expiry")
		}
		if !time.Now().Before(c.ExpiresAt.Time) {
			return nil, errors.New("access token expired")
		}
	}
	return c, nil
}

// jwks returns the public JWKS document so the (future external) broker, and any
// other relying party, can verify tokens offline.
func (a *Auth) jwks() map[string]interface{} {
	pub := a.priv.PublicKey
	eBuf := make([]byte, 8)
	binary.BigEndian.PutUint64(eBuf, uint64(pub.E))
	// trim leading zero bytes of the exponent
	i := 0
	for i < len(eBuf)-1 && eBuf[i] == 0 {
		i++
	}
	return map[string]interface{}{
		"keys": []map[string]interface{}{{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": a.kid,
			"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(eBuf[i:]),
		}},
	}
}
