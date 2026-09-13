package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/github"
)

// OAuth handles federated login (dev + GitHub) and the short-lived one-time codes
// the client exchanges (with PKCE) for an access token.
//
// Two PKCE/state stashes live in the ephemeralKV (Redis when clustered, in-process
// otherwise) so a multi-instance login survives the authorize→callback→token hops
// landing on different instances:
//   - pendingState: our authorize → IdP roundtrip (GitHub). Holds PKCE + redirect.
//   - pendingCode:  the code we hand the client, exchanged at /auth/token.
type OAuth struct {
	store *Store
	gh    *oauth2.Config // nil when GitHub not configured
	apple *appleConfig   // nil when Sign in with Apple not configured
	kv    ephemeralKV
}

type pendingState struct {
	Challenge   string `json:"c"`
	RedirectURI string `json:"r"`
	Provider    string `json:"p"`
	// Kind "github_link": not a login — an already signed-in user (UserID)
	// proving which GitHub account is theirs, so integrations can match PR
	// commenters back to them. The callback records the login and stops.
	Kind   string `json:"k,omitempty"`
	UserID string `json:"u,omitempty"`
}

type pendingCode struct {
	UserID      string `json:"u"`
	Challenge   string `json:"c"`
	RedirectURI string `json:"r"`
}

const (
	oauthStateTTL             = 10 * time.Minute
	oauthCodeTTL              = 5 * time.Minute
	githubOAuthAttempts       = 3
	githubOAuthAttemptTimeout = 12 * time.Second
)

var githubHTTPClient = &http.Client{Timeout: githubOAuthAttemptTimeout}

func NewOAuth(store *Store, ghClientID, ghSecret, publicURL string, kv ephemeralKV, apple *appleConfig) *OAuth {
	o := &OAuth{store: store, kv: kv, apple: apple}
	if ghClientID != "" && ghSecret != "" {
		o.gh = &oauth2.Config{
			ClientID:     ghClientID,
			ClientSecret: ghSecret,
			Endpoint:     github.Endpoint,
			RedirectURL:  publicURL + "/auth/github/callback",
			// `user:email` is deliberately absent: nothing reads an address any
			// more, and a scope you do not use is one more line on the consent
			// screen and one more field in the privacy declaration. Existing
			// grants keep working — GitHub simply asks for less next time.
			Scopes: []string{"read:user"},
		}
	}
	return o
}

func randToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// startAuthorize begins login: it returns the identity provider's authorize URL,
// with `state` stashing our own PKCE challenge and client redirect for the trip.
func (o *OAuth) startAuthorize(provider, redirectURI, challenge string) (string, error) {
	ctx := context.Background()
	switch provider {
	case "github":
		if o.gh == nil {
			return "", errors.New("github not configured")
		}
		state := randToken()
		if err := o.putState(ctx, state, &pendingState{Challenge: challenge, RedirectURI: redirectURI, Provider: "github"}); err != nil {
			return "", err
		}
		return o.gh.AuthCodeURL(state, oauth2.AccessTypeOnline), nil
	case "apple":
		if o.apple == nil {
			return "", errors.New("apple not configured")
		}
		state := randToken()
		if err := o.putState(ctx, state, &pendingState{Challenge: challenge, RedirectURI: redirectURI, Provider: "apple"}); err != nil {
			return "", err
		}
		return o.apple.authorizeURL(state), nil
	default:
		return "", errors.New("unknown provider")
	}
}

// completeApple handles Apple's callback: exchange their code for an id_token,
// upsert the user, mint our one-time code, and return the client redirect target.
// Mirrors completeGitHub.
func (o *OAuth) completeApple(ctx context.Context, state, appleCode string) (string, error) {
	raw, ok, err := o.kv.take(ctx, "oauth:state:"+state)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errors.New("invalid or expired state")
	}
	var ps pendingState
	if json.Unmarshal([]byte(raw), &ps) != nil {
		return "", errors.New("corrupt state")
	}
	if o.apple == nil {
		return "", errors.New("apple not configured")
	}

	identity, err := o.apple.exchange(ctx, appleCode)
	if err != nil {
		return oauthErrorRedirect(ps.RedirectURI, err), err
	}
	userID, err := o.store.UpsertUser("apple", identity.sub)
	if err != nil {
		return oauthErrorRedirect(ps.RedirectURI, err), err
	}

	code := randToken()
	if err := o.putCode(ctx, code, &pendingCode{UserID: userID, Challenge: ps.Challenge, RedirectURI: ps.RedirectURI}); err != nil {
		return "", err
	}
	return ps.RedirectURI + "?code=" + code, nil
}

// startGitHubLink begins an identity-only GitHub pass for a signed-in user
// (Settings → GitHub → Link GitHub account). Same OAuth App, same callback;
// the state carries who is linking.
func (o *OAuth) startGitHubLink(ctx context.Context, userID, redirectURI string) (string, error) {
	if o.gh == nil {
		return "", errors.New("github not configured")
	}
	state := randToken()
	if err := o.putState(ctx, state, &pendingState{RedirectURI: redirectURI, Provider: "github", Kind: "github_link", UserID: userID}); err != nil {
		return "", err
	}
	return o.gh.AuthCodeURL(state, oauth2.AccessTypeOnline), nil
}

func (o *OAuth) putState(ctx context.Context, state string, ps *pendingState) error {
	b, _ := json.Marshal(ps)
	return o.kv.put(ctx, "oauth:state:"+state, string(b), oauthStateTTL)
}

func (o *OAuth) putCode(ctx context.Context, code string, pc *pendingCode) error {
	b, _ := json.Marshal(pc)
	return o.kv.put(ctx, "oauth:code:"+code, string(b), oauthCodeTTL)
}

// completeGitHub handles GitHub's callback: exchange their code, fetch identity,
// upsert the user, mint our one-time code, and return the client redirect target.
func (o *OAuth) completeGitHub(ctx context.Context, state, ghCode string) (string, error) {
	raw, ok, err := o.kv.take(ctx, "oauth:state:"+state)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errors.New("invalid or expired state")
	}
	var ps pendingState
	if json.Unmarshal([]byte(raw), &ps) != nil {
		return "", errors.New("corrupt state")
	}
	if o.gh == nil {
		return "", errors.New("github not configured")
	}

	tok, err := o.exchangeGitHubToken(ctx, ghCode)
	if err != nil {
		return oauthErrorRedirect(ps.RedirectURI, err), err
	}
	sub, login, err := fetchGitHubIdentityWithRetry(ctx, o.gh, tok)
	if err != nil {
		return oauthErrorRedirect(ps.RedirectURI, err), err
	}
	if ps.Kind == "github_link" {
		if ps.UserID == "" {
			return "", errors.New("corrupt state")
		}
		if err := o.store.SetUserGitHubLogin(ps.UserID, login); err != nil {
			return oauthErrorRedirect(ps.RedirectURI, err), err
		}
		return redirectWith(ps.RedirectURI, map[string]string{"kind": "github_link", "login": login}), nil
	}
	userID, err := o.store.UpsertUser("github", sub)
	if err != nil {
		return oauthErrorRedirect(ps.RedirectURI, err), err
	}
	// The login is the GitHub-side member identity for integrations; a rename
	// is picked up on the next sign-in.
	if login != "" {
		_ = o.store.SetUserGitHubLogin(userID, login)
	}

	code := randToken()
	if err := o.putCode(ctx, code, &pendingCode{UserID: userID, Challenge: ps.Challenge, RedirectURI: ps.RedirectURI}); err != nil {
		return "", err
	}
	return ps.RedirectURI + "?code=" + code, nil
}

// exchangeCode validates PKCE and returns the userId bound to a one-time code.
func (o *OAuth) exchangeCode(code, verifier string) (string, error) {
	raw, ok, err := o.kv.take(context.Background(), "oauth:code:"+code)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errors.New("invalid or expired code")
	}
	var pc pendingCode
	if json.Unmarshal([]byte(raw), &pc) != nil {
		return "", errors.New("corrupt code")
	}
	if !verifyPKCE(pc.Challenge, verifier) {
		return "", errors.New("pkce verification failed")
	}
	return pc.UserID, nil
}

func verifyPKCE(challenge, verifier string) bool {
	if challenge == "" {
		return true // PoC: allow no-PKCE clients (e.g. curl tests)
	}
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:]) == challenge
}

func (o *OAuth) exchangeGitHubToken(ctx context.Context, ghCode string) (*oauth2.Token, error) {
	var lastErr error
	for attempt := 1; attempt <= githubOAuthAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, githubOAuthAttemptTimeout)
		attemptCtx = context.WithValue(attemptCtx, oauth2.HTTPClient, githubHTTPClient)
		tok, err := o.gh.Exchange(attemptCtx, ghCode)
		cancel()
		if err == nil {
			return tok, nil
		}
		lastErr = err
		if !isRetryableGitHubError(err) || attempt == githubOAuthAttempts {
			return nil, classifyGitHubOAuthError(err)
		}
		if err := sleepWithContext(ctx, time.Duration(attempt)*250*time.Millisecond); err != nil {
			return nil, err
		}
	}
	return nil, lastErr
}

func fetchGitHubIdentityWithRetry(ctx context.Context, cfg *oauth2.Config, tok *oauth2.Token) (string, string, error) {
	var lastErr error
	for attempt := 1; attempt <= githubOAuthAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, githubOAuthAttemptTimeout)
		attemptCtx = context.WithValue(attemptCtx, oauth2.HTTPClient, githubHTTPClient)
		sub, login, err := fetchGitHubIdentity(attemptCtx, cfg, tok)
		cancel()
		if err == nil {
			return sub, login, nil
		}
		lastErr = err
		if !isRetryableGitHubError(err) || attempt == githubOAuthAttempts {
			return "", "", classifyGitHubOAuthError(err)
		}
		if err := sleepWithContext(ctx, time.Duration(attempt)*250*time.Millisecond); err != nil {
			return "", "", err
		}
	}
	return "", "", lastErr
}

func isRetryableGitHubError(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && (netErr.Timeout() || netErr.Temporary())
}

func isGitHubOAuthTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func classifyGitHubOAuthError(err error) error {
	if isGitHubOAuthTimeout(err) {
		return newGitHubOAuthTimeoutError(err)
	}
	return err
}

func oauthErrorRedirect(redirectURI string, err error) string {
	u, parseErr := url.Parse(redirectURI)
	if parseErr != nil {
		return ""
	}
	q := u.Query()
	if code, message, ok := brokerErrorDetails(err); ok {
		q.Set("error", code)
		q.Set("error_code", code)
		q.Set("message", message)
	} else {
		q.Set("error", err.Error())
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// fetchGitHubIdentity returns the account key (the immutable numeric id — a
// rename does not change it) and the login. The login is not identity: it is
// the name PR comments arrive under, kept so integrations can match a
// commenter to an account. The address GitHub would also hand over here has
// no consumer — see Store.UpsertUser.
func fetchGitHubIdentity(ctx context.Context, cfg *oauth2.Config, tok *oauth2.Token) (sub, login string, err error) {
	client := cfg.Client(ctx, tok)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var u struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	if err := json.Unmarshal(body, &u); err != nil {
		return "", "", err
	}
	if u.ID == 0 {
		return "", "", errors.New("github identity fetch failed")
	}
	return hexInt(u.ID), u.Login, nil
}

func hexInt(n int64) string {
	b := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		b[i] = byte(n & 0xff)
		n >>= 8
	}
	return "github:" + hex.EncodeToString(b)
}
