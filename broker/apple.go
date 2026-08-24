package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Sign in with Apple.
//
// Required by App Store Guideline 4.8 once the app offers any other federated
// sign-in (GitHub, here). The shape differs from GitHub in three ways worth
// knowing before editing:
//
//   - The client secret is not a static string. It is an ES256 JWT the broker
//     signs with a .p8 key from the Apple developer portal, valid at most six
//     months, minted per request here.
//   - The identity arrives inside the returned id_token, not from a userinfo
//     call. Only `sub` is read: no scope is requested, so Apple sends no
//     address, and none would be used if it did (see Store.UpsertUser).
//   - The callback is a POST, because `response_mode=form_post` is set. That is
//     mandatory only when a scope is requested — it is kept here by choice, as
//     the route and the return URL registered with Apple are built around it.

const (
	appleIssuer       = "https://appleid.apple.com"
	appleAuthorizeURL = appleIssuer + "/auth/authorize"
	appleTokenURL     = appleIssuer + "/auth/token"
	// Apple caps client-secret lifetime at six months; stay well inside it.
	appleClientSecretTTL = 90 * 24 * time.Hour
)

var appleHTTPClient = &http.Client{Timeout: githubOAuthAttemptTimeout}

type appleConfig struct {
	teamID      string
	servicesID  string // the Services ID — Apple's `client_id` for web/native flows
	keyID       string
	key         *ecdsa.PrivateKey
	redirectURL string
}

// newAppleConfig returns nil when Apple sign-in isn't configured, which leaves
// the provider simply unavailable rather than breaking startup.
func newAppleConfig(publicURL string) (*appleConfig, error) {
	teamID := os.Getenv("APPLE_TEAM_ID")
	servicesID := os.Getenv("APPLE_SERVICES_ID")
	keyID := os.Getenv("APPLE_KEY_ID")
	rawKey := os.Getenv("APPLE_PRIVATE_KEY")
	if teamID == "" || servicesID == "" || keyID == "" || rawKey == "" {
		return nil, nil
	}
	key, err := parseAppleKey(rawKey)
	if err != nil {
		return nil, fmt.Errorf("APPLE_PRIVATE_KEY: %w", err)
	}
	return &appleConfig{
		teamID:      teamID,
		servicesID:  servicesID,
		keyID:       keyID,
		key:         key,
		redirectURL: publicURL + "/auth/apple/callback",
	}, nil
}

// parseAppleKey reads the PKCS#8 EC key from a downloaded AuthKey_XXXX.p8.
// Newlines are commonly lost when the key is pasted into an env var, so an
// escaped `\n` is accepted too.
func parseAppleKey(raw string) (*ecdsa.PrivateKey, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(raw), `\n`, "\n")
	block, _ := pem.Decode([]byte(normalized))
	if block == nil {
		return nil, errors.New("not a PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an ECDSA key")
	}
	return key, nil
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// clientSecret mints the short-lived ES256 JWT Apple wants in place of a static
// client secret.
func (a *appleConfig) clientSecret() (string, error) {
	now := time.Now()
	header, err := json.Marshal(map[string]string{"alg": "ES256", "kid": a.keyID, "typ": "JWT"})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]interface{}{
		"iss": a.teamID,
		"iat": now.Unix(),
		"exp": now.Add(appleClientSecretTTL).Unix(),
		"aud": appleIssuer,
		"sub": a.servicesID,
	})
	if err != nil {
		return "", err
	}

	signingInput := b64url(header) + "." + b64url(claims)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, a.key, digest[:])
	if err != nil {
		return "", err
	}
	// JOSE wants the raw R||S pair, each left-padded to the curve size — NOT the
	// ASN.1 DER encoding that ecdsa.SignASN1 produces. Apple rejects DER with an
	// unhelpful "invalid_client".
	size := (a.key.Curve.Params().BitSize + 7) / 8
	sig := make([]byte, 2*size)
	copyPadded(sig[:size], r)
	copyPadded(sig[size:], s)
	return signingInput + "." + b64url(sig), nil
}

func copyPadded(dst []byte, n *big.Int) {
	b := n.Bytes()
	copy(dst[len(dst)-len(b):], b)
}

func (a *appleConfig) authorizeURL(state string) string {
	q := url.Values{}
	q.Set("client_id", a.servicesID)
	q.Set("redirect_uri", a.redirectURL)
	q.Set("response_type", "code")
	// No scope is requested. All we need from Apple is a stable `sub` to key the
	// account on, and asking for an address we would never read is exactly the
	// data collection Guideline 4.8 tells you to avoid — see Store.UpsertUser
	// for why accounts are no longer linked by email.
	//
	// `form_post` is kept even though it is only *mandatory* when a scope is
	// requested: it is a valid response_mode either way, the callback route and
	// the return URL registered with Apple are already built around it, and
	// switching to a query redirect would buy nothing.
	q.Set("response_mode", "form_post")
	q.Set("state", state)
	return appleAuthorizeURL + "?" + q.Encode()
}

type appleIdentity struct {
	sub string
}

// exchangeAppleCode trades Apple's authorization code for an id_token and
// returns the identity inside it.
func (a *appleConfig) exchange(ctx context.Context, code string) (appleIdentity, error) {
	secret, err := a.clientSecret()
	if err != nil {
		return appleIdentity{}, err
	}
	form := url.Values{}
	form.Set("client_id", a.servicesID)
	form.Set("client_secret", secret)
	form.Set("code", code)
	form.Set("grant_type", "authorization_code")
	form.Set("redirect_uri", a.redirectURL)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, appleTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return appleIdentity{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := appleHTTPClient.Do(req)
	if err != nil {
		return appleIdentity{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return appleIdentity{}, fmt.Errorf("apple token exchange failed (%d)", resp.StatusCode)
	}
	var tok struct {
		IDToken string `json:"id_token"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return appleIdentity{}, err
	}
	if tok.IDToken == "" {
		return appleIdentity{}, errors.New("apple returned no id_token")
	}
	return a.identityFromIDToken(tok.IDToken)
}

// identityFromIDToken reads the subject out of Apple's id_token.
//
// The signature is deliberately not checked against Apple's JWKS. This token
// did not come through the user's browser — the broker just fetched it over a
// TLS connection it opened to appleid.apple.com itself, which OIDC Core
// §3.1.3.7 explicitly allows as a substitute for signature validation. The
// claims below are still checked, because those guard against a *correctly
// signed* token minted for somebody else's app.
func (a *appleConfig) identityFromIDToken(idToken string) (appleIdentity, error) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return appleIdentity{}, errors.New("malformed id_token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return appleIdentity{}, errors.New("malformed id_token payload")
	}
	var claims struct {
		Iss string `json:"iss"`
		Aud string `json:"aud"`
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return appleIdentity{}, err
	}
	if claims.Iss != appleIssuer {
		return appleIdentity{}, errors.New("id_token from unexpected issuer")
	}
	if claims.Aud != a.servicesID {
		return appleIdentity{}, errors.New("id_token for a different client")
	}
	if claims.Exp > 0 && time.Now().Unix() >= claims.Exp {
		return appleIdentity{}, errors.New("id_token expired")
	}
	if claims.Sub == "" {
		return appleIdentity{}, errors.New("id_token has no subject")
	}

	return appleIdentity{sub: "apple:" + claims.Sub}, nil
}
