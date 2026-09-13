package main

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Linear × GitHub integration: the broker holds the two official Apps' secrets,
// completes their install / link flows, proxies Linear GraphQL with the
// workspace's app token, mints short-lived GitHub installation tokens, and
// keeps the routing table webhooks are resolved against (webhooks.go).
// See docs/linear-github/design.md §3–§5.

const (
	linearAuthorizeURL = "https://linear.app/oauth/authorize"
	linearTokenURL     = "https://api.linear.app/oauth/token"
	linearGraphQLURL   = "https://api.linear.app/graphql"
	linearRevokeURL    = "https://api.linear.app/oauth/revoke"
	githubAPI          = "https://api.github.com"

	// The app scope: act as the agent (activities, assignable, mentionable).
	linearInstallScope = "read,write,issues:create,comments:create,app:mentionable,app:assignable"
	// The link scope: prove who a member is, nothing else. The token is dropped.
	linearLinkScope = "read"

	integrationStateTTL = 10 * time.Minute
	// Refresh the Linear token a little before Linear would reject it.
	linearTokenRefreshSlack = 2 * time.Minute
	githubAppJWTTTL         = 9 * time.Minute
	githubTokenTTL          = time.Hour
	collaboratorCacheTTL    = 10 * time.Minute
	defaultWebhookQueueTTL  = 30 * time.Minute
)

var integrationHTTPClient = &http.Client{Timeout: 20 * time.Second}

type integrationsConfig struct {
	publicURL string
	sealer    *sealer
	queueTTL  time.Duration

	linearClientID      string
	linearClientSecret  string
	linearWebhookSecret string

	githubAppID         string
	githubAppSlug       string
	githubAppKey        *rsa.PrivateKey
	githubWebhookSecret string

	// (installationID, repo, userID) → collaborator check result.
	collabMu    sync.Mutex
	collabCache map[string]collabEntry
	// Serializes Linear token refreshes per workspace.
	refreshMu sync.Mutex
}

type collabEntry struct {
	ok      bool
	expires time.Time
}

func (c *integrationsConfig) linearEnabled() bool {
	return c != nil && c.linearClientID != "" && c.linearClientSecret != "" && c.sealer != nil
}

func (c *integrationsConfig) githubEnabled() bool {
	return c != nil && c.githubAppID != "" && c.githubAppKey != nil
}

// newIntegrationsConfig reads the env. Missing pieces disable that half only;
// the error is for the startup log, the returned config is always usable.
func newIntegrationsConfig(publicURL string) (*integrationsConfig, error) {
	c := &integrationsConfig{
		publicURL:           strings.TrimRight(publicURL, "/"),
		queueTTL:            defaultWebhookQueueTTL,
		linearClientID:      os.Getenv("LINEAR_CLIENT_ID"),
		linearClientSecret:  os.Getenv("LINEAR_CLIENT_SECRET"),
		linearWebhookSecret: os.Getenv("LINEAR_WEBHOOK_SECRET"),
		githubAppID:         os.Getenv("GITHUB_APP_ID"),
		githubAppSlug:       os.Getenv("GITHUB_APP_SLUG"),
		githubWebhookSecret: os.Getenv("GITHUB_WEBHOOK_SECRET"),
		collabCache:         map[string]collabEntry{},
	}
	if v := os.Getenv("WEBHOOK_QUEUE_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			c.queueTTL = d
		}
	}
	var errs []string
	if kek := os.Getenv("INTEGRATION_KEK"); kek != "" {
		s, err := newSealer(kek)
		if err != nil {
			errs = append(errs, "INTEGRATION_KEK: "+err.Error())
		} else {
			c.sealer = s
		}
	} else if c.linearClientID != "" {
		errs = append(errs, "INTEGRATION_KEK unset: linear integration disabled")
	}
	keyPEM := os.Getenv("GITHUB_APP_PRIVATE_KEY")
	if keyPEM == "" {
		if p := os.Getenv("GITHUB_APP_PRIVATE_KEY_PATH"); p != "" {
			if b, err := os.ReadFile(p); err == nil {
				keyPEM = string(b)
			} else {
				errs = append(errs, "GITHUB_APP_PRIVATE_KEY_PATH: "+err.Error())
			}
		}
	}
	if keyPEM != "" {
		key, err := parseRSAPrivateKey(keyPEM)
		if err != nil {
			errs = append(errs, "GITHUB_APP_PRIVATE_KEY: "+err.Error())
		} else {
			c.githubAppKey = key
		}
	}
	if len(errs) > 0 {
		return c, errors.New(strings.Join(errs, "; "))
	}
	return c, nil
}

// requireUser accepts the user's access token or a node token of theirs. The
// desktop server calls these endpoints, and what it durably holds is the node
// token (the 48h access token is not refreshed on the desktop); a node token
// names the user just as well and is revocable per device.
func (s *Server) requireUser(r *http.Request) (*Claims, error) {
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, "Bearer ") {
		return nil, errors.New("missing bearer token")
	}
	c, err := s.auth.verify(strings.TrimPrefix(authz, "Bearer "))
	if err != nil {
		return nil, err
	}
	switch c.Typ {
	case "access":
		return c, nil
	case "node":
		node, ok, err := s.store.GetNode(c.NodeID)
		if err != nil {
			return nil, err
		}
		if !ok || node.RevokedAt != 0 || node.UserID != c.Subject {
			return nil, errors.New("node revoked or unknown")
		}
		return c, nil
	}
	return nil, errors.New("unsupported token")
}

// --- state for the install / link redirects ---

type integrationState struct {
	Kind        string `json:"k"` // linear_install | linear_link | github_install
	UserID      string `json:"u"`
	NodeID      string `json:"n"`
	RedirectURI string `json:"r"`
}

func (s *Server) putIntegrationState(ctx context.Context, st *integrationState) (string, error) {
	state := randToken()
	b, _ := json.Marshal(st)
	return state, s.oauth.kv.put(ctx, "integ:state:"+state, string(b), integrationStateTTL)
}

func (s *Server) takeIntegrationState(ctx context.Context, state string) (*integrationState, error) {
	raw, ok, err := s.oauth.kv.take(ctx, "integ:state:"+state)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("invalid or expired state")
	}
	var st integrationState
	if json.Unmarshal([]byte(raw), &st) != nil {
		return nil, errors.New("corrupt state")
	}
	return &st, nil
}

// isAllowedIntegrationRedirectURI: the desktop loopback (any port) or a
// configured web origin, and only the integrations callback path — the
// browser lands here with an org id, never a token, but an open redirect is
// an open redirect.
func isAllowedIntegrationRedirectURI(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Path != "/integrations/callback" {
		return false
	}
	return isAllowedBrowserOrigin(originFromURL(u))
}

func redirectWith(base string, params map[string]string) string {
	u, err := url.Parse(base)
	if err != nil {
		return ""
	}
	q := u.Query()
	for k, v := range params {
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// startIntegrationRedirect validates the caller and the redirect_uri, stashes
// state, and returns (claims, state, redirectURI). nodeId is optional: the
// desktop passes its own so the link flow can record a default node.
func (s *Server) startIntegrationRedirect(w http.ResponseWriter, r *http.Request, kind string) (*Claims, string, bool) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return nil, "", false
	}
	redirectURI := r.URL.Query().Get("redirect_uri")
	if !isAllowedIntegrationRedirectURI(redirectURI) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "redirect_uri not allowed"})
		return nil, "", false
	}
	state, err := s.putIntegrationState(r.Context(), &integrationState{
		Kind: kind, UserID: claims.Subject, NodeID: r.URL.Query().Get("node_id"), RedirectURI: redirectURI,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "state store unavailable"})
		return nil, "", false
	}
	return claims, state, true
}

// ===================== Linear =====================

// GET /integrations/linear/install?redirect_uri=&node_id= → { url } for the browser
func (s *Server) handleLinearInstall(w http.ResponseWriter, r *http.Request) {
	if !s.integrations.linearEnabled() {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "linear integration not configured"})
		return
	}
	_, state, ok := s.startIntegrationRedirect(w, r, "linear_install")
	if !ok {
		return
	}
	q := url.Values{}
	q.Set("client_id", s.integrations.linearClientID)
	q.Set("redirect_uri", s.integrations.publicURL+"/integrations/linear/callback")
	q.Set("response_type", "code")
	q.Set("scope", linearInstallScope)
	q.Set("state", state)
	q.Set("actor", "app")
	q.Set("prompt", "consent")
	writeJSON(w, http.StatusOK, map[string]string{"url": linearAuthorizeURL + "?" + q.Encode()})
}

// GET /integrations/linear/link?redirect_uri=&node_id= → { url } for the browser
func (s *Server) handleLinearLink(w http.ResponseWriter, r *http.Request) {
	if !s.integrations.linearEnabled() {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "linear integration not configured"})
		return
	}
	_, state, ok := s.startIntegrationRedirect(w, r, "linear_link")
	if !ok {
		return
	}
	q := url.Values{}
	q.Set("client_id", s.integrations.linearClientID)
	q.Set("redirect_uri", s.integrations.publicURL+"/integrations/linear/callback")
	q.Set("response_type", "code")
	q.Set("scope", linearLinkScope)
	q.Set("state", state)
	writeJSON(w, http.StatusOK, map[string]string{"url": linearAuthorizeURL + "?" + q.Encode()})
}

type linearTokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

func (s *Server) linearTokenRequest(ctx context.Context, form url.Values) (*linearTokenResponse, error) {
	form.Set("client_id", s.integrations.linearClientID)
	form.Set("client_secret", s.integrations.linearClientSecret)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, linearTokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := integrationHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var tr linearTokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("linear token: %s", truncateForLog(body))
	}
	if resp.StatusCode/100 != 2 || tr.AccessToken == "" {
		if tr.Error != "" {
			return nil, fmt.Errorf("linear token: %s %s", tr.Error, tr.ErrorDesc)
		}
		return nil, fmt.Errorf("linear token: http %d", resp.StatusCode)
	}
	return &tr, nil
}

func truncateForLog(b []byte) string {
	s := string(b)
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

type linearViewer struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Org   struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		URLKey string `json:"urlKey"`
	} `json:"organization"`
}

func linearGraphQL(ctx context.Context, token, query string, variables map[string]any) (json.RawMessage, int, error) {
	payload, _ := json.Marshal(map[string]any{"query": query, "variables": variables})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, linearGraphQLURL, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := integrationHTTPClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return body, resp.StatusCode, nil
}

func fetchLinearViewer(ctx context.Context, token string) (*linearViewer, error) {
	body, status, err := linearGraphQL(ctx, token, `{ viewer { id name email organization { id name urlKey } } }`, nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Data struct {
			Viewer linearViewer `json:"viewer"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(body, &out); err != nil || status/100 != 2 || out.Data.Viewer.ID == "" {
		if len(out.Errors) > 0 {
			return nil, errors.New("linear viewer: " + out.Errors[0].Message)
		}
		return nil, fmt.Errorf("linear viewer: http %d", status)
	}
	return &out.Data.Viewer, nil
}

// GET /integrations/linear/callback?code&state — both the install and the
// link flow land here; the state says which.
func (s *Server) handleLinearCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	st, err := s.takeIntegrationState(ctx, r.URL.Query().Get("state"))
	if err != nil {
		writeErrorResponse(w, http.StatusBadRequest, err)
		return
	}
	fail := func(code string, err error) {
		slog.Warn("linear callback failed", "kind", st.Kind, "user", st.UserID, "code", code, "err", err)
		http.Redirect(w, r, redirectWith(st.RedirectURI, map[string]string{"kind": st.Kind, "error": code}), http.StatusFound)
	}
	if e := r.URL.Query().Get("error"); e != "" {
		fail(e, errors.New(r.URL.Query().Get("error_description")))
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		fail("missing_code", nil)
		return
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", s.integrations.publicURL+"/integrations/linear/callback")
	tok, err := s.linearTokenRequest(ctx, form)
	if err != nil {
		fail("token_exchange_failed", err)
		return
	}
	viewer, err := fetchLinearViewer(ctx, tok.AccessToken)
	if err != nil {
		fail("viewer_failed", err)
		return
	}

	switch st.Kind {
	case "linear_install":
		accEnc, err := s.integrations.sealer.seal(tok.AccessToken)
		if err != nil {
			fail("seal_failed", err)
			return
		}
		refEnc := ""
		if tok.RefreshToken != "" {
			if refEnc, err = s.integrations.sealer.seal(tok.RefreshToken); err != nil {
				fail("seal_failed", err)
				return
			}
		}
		var expiresAt int64
		if tok.ExpiresIn > 0 {
			expiresAt = time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second).UnixMilli()
		}
		if err := s.store.UpsertLinearInstall(LinearInstallRow{
			OrgID: viewer.Org.ID, InstalledByUserID: st.UserID,
			AppUserID: viewer.ID, AppUserName: viewer.Name,
			WorkspaceName: viewer.Org.Name, URLKey: viewer.Org.URLKey,
			AccessTokenEnc: accEnc, RefreshTokenEnc: refEnc, ExpiresAt: expiresAt,
		}); err != nil {
			fail("store_failed", err)
			return
		}
		slog.Info("linear app installed", "org", viewer.Org.ID, "workspace", viewer.Org.Name, "user", st.UserID)
		http.Redirect(w, r, redirectWith(st.RedirectURI, map[string]string{"kind": st.Kind, "org": viewer.Org.ID}), http.StatusFound)

	case "linear_link":
		// The token proved who they are; that is all it was for.
		go revokeLinearToken(s.integrations, tok.AccessToken)
		if _, ok, err := s.store.GetLinearInstall(viewer.Org.ID); err != nil {
			fail("store_failed", err)
			return
		} else if !ok {
			fail("not_installed", nil)
			return
		}
		if err := s.store.UpsertLinearIdentity(LinearIdentityRow{
			OrgID: viewer.Org.ID, LinearUserID: viewer.ID, UserID: st.UserID,
			DefaultNodeID: st.NodeID, DisplayName: viewer.Name,
		}); err != nil {
			fail("store_failed", err)
			return
		}
		slog.Info("linear identity linked", "org", viewer.Org.ID, "linearUser", viewer.ID, "user", st.UserID, "node", st.NodeID)
		http.Redirect(w, r, redirectWith(st.RedirectURI, map[string]string{"kind": st.Kind, "org": viewer.Org.ID}), http.StatusFound)

	default:
		fail("bad_state", nil)
	}
}

func revokeLinearToken(c *integrationsConfig, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, linearRevokeURL, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := integrationHTTPClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

// linearAppToken returns a usable app token for the workspace, refreshing
// first when it is about to expire.
func (s *Server) linearAppToken(ctx context.Context, install LinearInstallRow) (string, error) {
	c := s.integrations
	if install.RevokedAt != 0 {
		return "", errLinearReinstall
	}
	if install.ExpiresAt == 0 || time.Now().Add(linearTokenRefreshSlack).UnixMilli() < install.ExpiresAt {
		return c.sealer.open(install.AccessTokenEnc)
	}
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()
	// Re-read: another request may have refreshed while we waited.
	fresh, ok, err := s.store.GetLinearInstall(install.OrgID)
	if err != nil || !ok {
		return "", errLinearReinstall
	}
	if time.Now().Add(linearTokenRefreshSlack).UnixMilli() < fresh.ExpiresAt {
		return c.sealer.open(fresh.AccessTokenEnc)
	}
	refresh, err := c.sealer.open(fresh.RefreshTokenEnc)
	if err != nil || refresh == "" {
		return "", errLinearReinstall
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", refresh)
	tok, err := s.linearTokenRequest(ctx, form)
	if err != nil {
		slog.Warn("linear token refresh failed", "org", install.OrgID, "err", err)
		_ = s.store.RevokeLinearInstall(install.OrgID)
		return "", errLinearReinstall
	}
	accEnc, _ := c.sealer.seal(tok.AccessToken)
	refEnc := fresh.RefreshTokenEnc
	if tok.RefreshToken != "" {
		refEnc, _ = c.sealer.seal(tok.RefreshToken)
	}
	var expiresAt int64
	if tok.ExpiresIn > 0 {
		expiresAt = time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second).UnixMilli()
	}
	if err := s.store.UpdateLinearInstallToken(install.OrgID, accEnc, refEnc, expiresAt); err != nil {
		return "", err
	}
	return tok.AccessToken, nil
}

var errLinearReinstall = errors.New("linear_reinstall_required")

// linearMember checks that the caller may act in the workspace: a linked
// identity, or the installer.
func (s *Server) linearMember(orgID, userID string) (LinearInstallRow, bool, error) {
	install, ok, err := s.store.GetLinearInstall(orgID)
	if err != nil || !ok {
		return LinearInstallRow{}, false, err
	}
	if install.InstalledByUserID == userID {
		return install, true, nil
	}
	_, linked, err := s.store.GetLinearIdentityByUser(orgID, userID)
	return install, linked, err
}

// POST /integrations/linear/graphql { orgId, query, variables }
//
// The desktop never sees the app token: it sends the GraphQL document here and
// the broker forwards it as the workspace's agent. Response status and body are
// relayed as-is so the desktop client can treat this like talking to Linear.
func (s *Server) handleLinearGraphQL(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	if !s.integrations.linearEnabled() {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "linear integration not configured"})
		return
	}
	var body struct {
		OrgID     string         `json:"orgId"`
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body); err != nil || body.OrgID == "" || body.Query == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "orgId and query required"})
		return
	}
	install, member, err := s.linearMember(body.OrgID, claims.Subject)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if !member {
		writeBrokerError(w, http.StatusForbidden, "linear_not_linked", "Link your Linear account in Settings → Linear first.")
		return
	}
	token, err := s.linearAppToken(r.Context(), install)
	if err != nil {
		if errors.Is(err, errLinearReinstall) {
			writeBrokerError(w, http.StatusConflict, "linear_reinstall_required", "The Linear workspace agent needs to be reinstalled by a workspace admin.")
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	out, status, err := linearGraphQL(r.Context(), token, body.Query, body.Variables)
	if err != nil {
		writeBrokerError(w, http.StatusBadGateway, "linear_unreachable", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(out)
}

// DELETE /integrations/linear/{orgId} — installer only; the bot leaves the workspace.
func (s *Server) handleLinearUninstall(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	orgID := r.PathValue("orgId")
	install, ok, err := s.store.GetLinearInstall(orgID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if !ok || install.InstalledByUserID != claims.Subject {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not the installer"})
		return
	}
	if s.integrations.linearEnabled() {
		if tok, err := s.integrations.sealer.open(install.AccessTokenEnc); err == nil && tok != "" {
			go revokeLinearToken(s.integrations, tok)
		}
	}
	if err := s.store.RevokeLinearInstall(orgID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// DELETE /integrations/linear/{orgId}/identity — the caller's own link.
func (s *Server) handleLinearUnlink(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	if err := s.store.DeleteLinearIdentity(r.PathValue("orgId"), claims.Subject); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ===================== GitHub =====================

func (c *integrationsConfig) githubAppJWT() (string, error) {
	now := time.Now()
	claims := jwt.RegisteredClaims{
		Issuer:    c.githubAppID,
		IssuedAt:  jwt.NewNumericDate(now.Add(-60 * time.Second)),
		ExpiresAt: jwt.NewNumericDate(now.Add(githubAppJWTTTL)),
	}
	return jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(c.githubAppKey)
}

func githubRequest(ctx context.Context, method, path, bearer string, body any) (json.RawMessage, int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(ctx, method, githubAPI+path, rd)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Authorization", "Bearer "+bearer)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := integrationHTTPClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return out, resp.StatusCode, nil
}

type githubInstallationToken struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

// mintInstallationToken asks GitHub for a one-hour token for the installation,
// narrowed to the named repositories when given.
func (s *Server) mintInstallationToken(ctx context.Context, installationID int64, repoNames []string) (*githubInstallationToken, error) {
	appJWT, err := s.integrations.githubAppJWT()
	if err != nil {
		return nil, err
	}
	var body any
	if len(repoNames) > 0 {
		body = map[string]any{"repositories": repoNames}
	}
	out, status, err := githubRequest(ctx, http.MethodPost, fmt.Sprintf("/app/installations/%d/access_tokens", installationID), appJWT, body)
	if err != nil {
		return nil, err
	}
	if status/100 != 2 {
		return nil, fmt.Errorf("github access_tokens: http %d %s", status, truncateForLog(out))
	}
	var tok githubInstallationToken
	if err := json.Unmarshal(out, &tok); err != nil || tok.Token == "" {
		return nil, errors.New("github access_tokens: bad response")
	}
	return &tok, nil
}

// listInstallationRepos pages through everything the installation covers.
func (s *Server) listInstallationRepos(ctx context.Context, installationID int64) (account string, repos []string, err error) {
	appJWT, err := s.integrations.githubAppJWT()
	if err != nil {
		return "", nil, err
	}
	out, status, err := githubRequest(ctx, http.MethodGet, fmt.Sprintf("/app/installations/%d", installationID), appJWT, nil)
	if err != nil {
		return "", nil, err
	}
	if status/100 != 2 {
		return "", nil, fmt.Errorf("github installation: http %d", status)
	}
	var inst struct {
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
	}
	_ = json.Unmarshal(out, &inst)
	tok, err := s.mintInstallationToken(ctx, installationID, nil)
	if err != nil {
		return "", nil, err
	}
	for page := 1; page <= 20; page++ {
		out, status, err := githubRequest(ctx, http.MethodGet, fmt.Sprintf("/installation/repositories?per_page=100&page=%d", page), tok.Token, nil)
		if err != nil {
			return "", nil, err
		}
		if status/100 != 2 {
			return "", nil, fmt.Errorf("github installation/repositories: http %d", status)
		}
		var res struct {
			Repositories []struct {
				FullName string `json:"full_name"`
			} `json:"repositories"`
		}
		if err := json.Unmarshal(out, &res); err != nil {
			return "", nil, err
		}
		for _, r := range res.Repositories {
			repos = append(repos, r.FullName)
		}
		if len(res.Repositories) < 100 {
			break
		}
	}
	return inst.Account.Login, repos, nil
}

// GET /integrations/github/install?redirect_uri=&node_id=
func (s *Server) handleGitHubInstall(w http.ResponseWriter, r *http.Request) {
	if !s.integrations.githubEnabled() || s.integrations.githubAppSlug == "" {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "github app not configured"})
		return
	}
	_, state, ok := s.startIntegrationRedirect(w, r, "github_install")
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": "https://github.com/apps/" + url.PathEscape(s.integrations.githubAppSlug) + "/installations/new?state=" + url.QueryEscape(state)})
}

// GET /integrations/github/callback?installation_id&setup_action&state
func (s *Server) handleGitHubAppCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	st, err := s.takeIntegrationState(ctx, r.URL.Query().Get("state"))
	if err != nil {
		writeErrorResponse(w, http.StatusBadRequest, err)
		return
	}
	fail := func(code string, err error) {
		slog.Warn("github callback failed", "user", st.UserID, "code", code, "err", err)
		http.Redirect(w, r, redirectWith(st.RedirectURI, map[string]string{"kind": st.Kind, "error": code}), http.StatusFound)
	}
	idStr := r.URL.Query().Get("installation_id")
	installationID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || installationID <= 0 {
		fail("missing_installation", nil)
		return
	}
	account, repos, err := s.listInstallationRepos(ctx, installationID)
	if err != nil {
		fail("github_failed", err)
		return
	}
	if err := s.store.UpsertGitHubInstall(GitHubInstallRow{InstallationID: installationID, InstalledByUserID: st.UserID, AccountLogin: account}); err != nil {
		fail("store_failed", err)
		return
	}
	if err := s.store.ReplaceGitHubInstallRepos(installationID, repos); err != nil {
		fail("store_failed", err)
		return
	}
	slog.Info("github app installed", "installation", installationID, "account", account, "repos", len(repos), "user", st.UserID)
	http.Redirect(w, r, redirectWith(st.RedirectURI, map[string]string{"kind": st.Kind, "installation": idStr}), http.StatusFound)
}

// GET /integrations/github/link?redirect_uri= — an identity-only pass through
// the login OAuth App, for accounts that signed in with Apple and therefore
// have no github_login yet. Lands on /auth/github/callback like a login.
func (s *Server) handleGitHubLink(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	if s.oauth.gh == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "github login not configured"})
		return
	}
	redirectURI := r.URL.Query().Get("redirect_uri")
	if !isAllowedIntegrationRedirectURI(redirectURI) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "redirect_uri not allowed"})
		return
	}
	target, err := s.oauth.startGitHubLink(r.Context(), claims.Subject, redirectURI)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": target})
}

func splitRepo(full string) (owner, name string, ok bool) {
	parts := strings.Split(strings.TrimSpace(full), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// userMayUseRepo: the installer, or a collaborator with write access.
func (s *Server) userMayUseRepo(ctx context.Context, install GitHubInstallRow, userID, fullName string) (bool, error) {
	if install.InstalledByUserID == userID {
		return true, nil
	}
	login, err := s.store.GitHubLoginOfUser(userID)
	if err != nil {
		return false, err
	}
	if login == "" {
		return false, nil
	}
	c := s.integrations
	key := fmt.Sprintf("%d|%s|%s", install.InstallationID, strings.ToLower(fullName), userID)
	c.collabMu.Lock()
	if e, ok := c.collabCache[key]; ok && time.Now().Before(e.expires) {
		c.collabMu.Unlock()
		return e.ok, nil
	}
	c.collabMu.Unlock()

	owner, name, ok := splitRepo(fullName)
	if !ok {
		return false, nil
	}
	tok, err := s.mintInstallationToken(ctx, install.InstallationID, []string{name})
	if err != nil {
		return false, err
	}
	out, status, err := githubRequest(ctx, http.MethodGet, fmt.Sprintf("/repos/%s/%s/collaborators/%s/permission", owner, name, url.PathEscape(login)), tok.Token, nil)
	if err != nil {
		return false, err
	}
	allowed := false
	if status/100 == 2 {
		var p struct {
			Permission string `json:"permission"`
		}
		_ = json.Unmarshal(out, &p)
		allowed = p.Permission == "write" || p.Permission == "maintain" || p.Permission == "admin"
	}
	c.collabMu.Lock()
	c.collabCache[key] = collabEntry{ok: allowed, expires: time.Now().Add(collaboratorCacheTTL)}
	c.collabMu.Unlock()
	return allowed, nil
}

// POST /integrations/github/installations/{id}/token { repo: "owner/name" }
func (s *Server) handleGitHubInstallationToken(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	if !s.integrations.githubEnabled() {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "github app not configured"})
		return
	}
	installationID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad installation id"})
		return
	}
	var body struct {
		Repo string `json:"repo"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body)
	_, name, ok := splitRepo(body.Repo)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "repo (owner/name) required"})
		return
	}
	install, found, err := s.store.GetGitHubInstall(installationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if !found || install.RevokedAt != 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "installation unknown"})
		return
	}
	allowed, err := s.userMayUseRepo(r.Context(), install, claims.Subject, body.Repo)
	if err != nil {
		writeBrokerError(w, http.StatusBadGateway, "github_unreachable", err.Error())
		return
	}
	if !allowed {
		writeBrokerError(w, http.StatusForbidden, "github_no_access", "Your GitHub account has no write access to this repository, or is not linked to operon.")
		return
	}
	tok, err := s.mintInstallationToken(r.Context(), installationID, []string{name})
	if err != nil {
		writeBrokerError(w, http.StatusBadGateway, "github_unreachable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": tok.Token, "expiresAt": tok.ExpiresAt, "installationId": installationID, "repo": body.Repo})
}

// GET /integrations/github/repos/{owner}/{name} — which installation covers it.
func (s *Server) handleGitHubRepoLookup(w http.ResponseWriter, r *http.Request) {
	if _, err := s.requireUser(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	full := r.PathValue("owner") + "/" + r.PathValue("name")
	install, ok, err := s.store.GitHubInstallForRepo(full)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"repo": full, "covered": false, "appSlug": s.integrations.githubAppSlug})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"repo": full, "covered": true, "installationId": install.InstallationID, "accountLogin": install.AccountLogin, "appSlug": s.integrations.githubAppSlug})
}

// DELETE /integrations/github/installations/{id} — forget it here; the user
// removes the App on GitHub (the installation webhook keeps the table honest).
func (s *Server) handleGitHubUninstall(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	installationID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad installation id"})
		return
	}
	install, ok, err := s.store.GetGitHubInstall(installationID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	if !ok || install.InstalledByUserID != claims.Subject {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not the installer"})
		return
	}
	if err := s.store.RevokeGitHubInstall(installationID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ===================== routes + status =====================

// The only routes a desktop writes are sticky ones: the issue it published,
// the pull request it opened. Which machine handles a Linear team or a GitHub
// repository is never declared — the desktop reads the repository off the
// issue's `repo:` label, and a person's delegations go to the node they
// linked from (linear_identities.default_node_id).
var stickyRouteKinds = map[string]bool{"linear_issue": true, "github_pr": true}

// PUT /integrations/routes { nodeId, routes: [{kind, key}] }
func (s *Server) handleRoutesPut(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	var body struct {
		NodeID string `json:"nodeId"`
		Routes []struct {
			Kind string `json:"kind"`
			Key  string `json:"key"`
		} `json:"routes"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil || body.NodeID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nodeId and routes required"})
		return
	}
	node, ok, err := s.store.GetNode(body.NodeID)
	if err != nil || !ok || node.UserID != claims.Subject || node.RevokedAt != 0 {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "node not owned"})
		return
	}
	for _, rt := range body.Routes {
		if !stickyRouteKinds[rt.Kind] || rt.Key == "" {
			continue
		}
		if err := s.store.UpsertRoute(claims.Subject, rt.Kind, rt.Key, body.NodeID); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// GET /integrations/status — everything the Settings page shows.
func (s *Server) handleIntegrationsStatus(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireUser(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	uid := claims.Subject
	type linearInstallView struct {
		OrgID          string `json:"orgId"`
		WorkspaceName  string `json:"workspaceName"`
		URLKey         string `json:"urlKey"`
		AppUserID      string `json:"appUserId"`
		AppUserName    string `json:"appUserName"`
		InstalledByMe  bool   `json:"installedByMe"`
		Linked         bool   `json:"linked"`
		LinearUserID   string `json:"linearUserId,omitempty"`
		LinearUserName string `json:"linearUserName,omitempty"`
		DefaultNodeID  string `json:"defaultNodeId,omitempty"`
		Revoked        bool   `json:"revoked"`
	}
	type githubInstallView struct {
		InstallationID int64    `json:"installationId"`
		AccountLogin   string   `json:"accountLogin"`
		Repos          []string `json:"repos"`
	}
	linearInstalls, err := s.store.LinearInstallsVisibleTo(uid)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	lv := []linearInstallView{}
	for _, in := range linearInstalls {
		v := linearInstallView{
			OrgID: in.OrgID, WorkspaceName: in.WorkspaceName, URLKey: in.URLKey,
			AppUserID: in.AppUserID, AppUserName: in.AppUserName,
			InstalledByMe: in.InstalledByUserID == uid, Revoked: in.RevokedAt != 0,
		}
		if id, ok, _ := s.store.GetLinearIdentityByUser(in.OrgID, uid); ok {
			v.Linked = true
			v.LinearUserID = id.LinearUserID
			v.LinearUserName = id.DisplayName
			v.DefaultNodeID = id.DefaultNodeID
		}
		lv = append(lv, v)
	}
	ghInstalls, err := s.store.ListGitHubInstallsBy(uid)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	gv := []githubInstallView{}
	for _, in := range ghInstalls {
		repos, _ := s.store.GitHubInstallRepos(in.InstallationID)
		gv = append(gv, githubInstallView{InstallationID: in.InstallationID, AccountLogin: in.AccountLogin, Repos: repos})
	}
	login, _ := s.store.GitHubLoginOfUser(uid)
	writeJSON(w, http.StatusOK, map[string]any{
		"linear": map[string]any{"enabled": s.integrations.linearEnabled(), "installs": lv},
		"github": map[string]any{"enabled": s.integrations.githubEnabled(), "appSlug": s.integrations.githubAppSlug, "login": login, "installs": gv},
	})
}
