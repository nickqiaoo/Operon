package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testAppleConfig(t *testing.T) *appleConfig {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return &appleConfig{
		teamID:      "TEAM123456",
		servicesID:  "com.operon.app.service",
		keyID:       "KEY123456",
		key:         key,
		redirectURL: "https://broker.example/auth/apple/callback",
	}
}

// Requesting a scope is how the broker would start receiving addresses again —
// and `scope=email` additionally makes `response_mode=form_post` mandatory
// rather than merely chosen. Accounts are keyed on Apple's `sub` alone, so
// there is nothing to ask for.
func TestAppleAuthorizeURLRequestsNoScope(t *testing.T) {
	cfg := testAppleConfig(t)
	raw := cfg.authorizeURL("state-123")
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse authorize URL: %v", err)
	}
	q := u.Query()
	if _, ok := q["scope"]; ok {
		t.Errorf("authorize URL requests scope %q, want none", q.Get("scope"))
	}
	if got := q.Get("response_mode"); got != "form_post" {
		t.Errorf("response_mode = %q, want form_post", got)
	}
	if got := q.Get("client_id"); got != cfg.servicesID {
		t.Errorf("client_id = %q, want the Services ID %q", got, cfg.servicesID)
	}
}

// The client secret is the one place a silent bug costs a full round-trip to
// Apple to notice ("invalid_client" and nothing else), so verify the signature
// the same way Apple would.
func TestAppleClientSecretIsVerifiableES256(t *testing.T) {
	cfg := testAppleConfig(t)
	secret, err := cfg.clientSecret()
	if err != nil {
		t.Fatalf("clientSecret: %v", err)
	}
	parts := strings.Split(secret, ".")
	if len(parts) != 3 {
		t.Fatalf("expected 3 JWT segments, got %d", len(parts))
	}

	var header map[string]string
	decodeSegment(t, parts[0], &header)
	if header["alg"] != "ES256" || header["kid"] != cfg.keyID {
		t.Fatalf("unexpected header %v", header)
	}

	var claims map[string]interface{}
	decodeSegment(t, parts[1], &claims)
	if claims["iss"] != cfg.teamID {
		t.Errorf("iss = %v, want team id", claims["iss"])
	}
	if claims["sub"] != cfg.servicesID {
		t.Errorf("sub = %v, want services id", claims["sub"])
	}
	if claims["aud"] != appleIssuer {
		t.Errorf("aud = %v, want %s", claims["aud"], appleIssuer)
	}

	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	// Raw R||S, not DER — a DER signature would be a different length and Apple
	// would reject it.
	if len(sig) != 64 {
		t.Fatalf("signature length = %d, want 64 (raw R||S)", len(sig))
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(&cfg.key.PublicKey, digest[:], r, s) {
		t.Fatal("signature does not verify against the signing key")
	}
}

func TestAppleIDTokenClaimValidation(t *testing.T) {
	cfg := testAppleConfig(t)
	exp := time.Now().Add(time.Hour).Unix()

	tests := []struct {
		name    string
		claims  map[string]interface{}
		wantErr bool
		wantSub string
	}{
		{
			name:    "the subject is the whole identity",
			claims:  map[string]interface{}{"iss": appleIssuer, "aud": cfg.servicesID, "sub": "001", "exp": exp},
			wantSub: "apple:001",
		},
		{
			// No scope is requested, so Apple should not send an address at all —
			// but if one ever turns up it must not be read. Accounts are keyed on
			// `sub` alone and an email must never become a way to reach one (see
			// Store.UpsertUser). This case exists to fail loudly if that is undone.
			name:    "an email claim is ignored even when present",
			claims:  map[string]interface{}{"iss": appleIssuer, "aud": cfg.servicesID, "sub": "002", "exp": exp, "email": "victim@example.com", "email_verified": true},
			wantSub: "apple:002",
		},
		{
			name:    "token minted for another client is rejected",
			claims:  map[string]interface{}{"iss": appleIssuer, "aud": "com.someone.else", "sub": "004", "exp": exp},
			wantErr: true,
		},
		{
			name:    "token from another issuer is rejected",
			claims:  map[string]interface{}{"iss": "https://evil.example", "aud": cfg.servicesID, "sub": "005", "exp": exp},
			wantErr: true,
		},
		{
			name:    "expired token is rejected",
			claims:  map[string]interface{}{"iss": appleIssuer, "aud": cfg.servicesID, "sub": "006", "exp": time.Now().Add(-time.Hour).Unix()},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			identity, err := cfg.identityFromIDToken(fakeIDToken(t, tc.claims))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got identity %+v", identity)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if identity.sub != tc.wantSub {
				t.Errorf("sub = %q, want %q", identity.sub, tc.wantSub)
			}
		})
	}
}

func TestNativeRedirectURIAllowlist(t *testing.T) {
	if !isAllowedRedirectURI(nativeRedirectURI) {
		t.Error("the app's own redirect must be allowed")
	}
	// Exact match only — anything looser on a custom scheme is an open redirect.
	for _, bad := range []string{
		"operon://auth/callback/../evil",
		"operon://evil/callback",
		"operon://auth/callback?next=https://evil.example",
		"operon://auth/callbackx",
		"operonx://auth/callback",
	} {
		if isAllowedRedirectURI(bad) {
			t.Errorf("%q must not be allowed", bad)
		}
	}
}

// A native redirect must never take the localhost shortcut that lets a dev
// client skip PKCE.
func TestNativeRedirectURIRequiresPKCE(t *testing.T) {
	if isLocalRedirectURI(nativeRedirectURI) {
		t.Error("native redirect must not count as local, or handleAuthorize would stop requiring a code_challenge")
	}
}

func decodeSegment(t *testing.T, segment string, out interface{}) {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		t.Fatalf("decode segment: %v", err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("unmarshal segment: %v", err)
	}
}

func fakeIDToken(t *testing.T, claims map[string]interface{}) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	// The signature is never checked (see identityFromIDToken), so a placeholder
	// third segment is enough to exercise the claim checks.
	return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}
