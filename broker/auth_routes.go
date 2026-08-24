package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	refreshCookieName = "operon_refresh"
	refreshSessionTTL = 90 * 24 * time.Hour
)

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeAccessToken(w http.ResponseWriter, status int, access string) {
	writeJSON(w, status, map[string]interface{}{
		"access":     access,
		"token_type": "Bearer",
		"expires_in": int(accessTTL.Seconds()),
	})
}

// writeTokenPair answers a native client, which carries its own refresh token
// instead of relying on a cookie.
//
// The packaged iOS app loads from its own origin, so the broker is a third
// party to it and WKWebView's tracking prevention silently drops the
// SameSite=None refresh cookie. Handing the token to the app — which keeps it
// in the keychain, not in web storage — is the only arrangement that survives.
func writeTokenPair(w http.ResponseWriter, status int, access, refresh string) {
	writeJSON(w, status, map[string]interface{}{
		"access":     access,
		"refresh":    refresh,
		"token_type": "Bearer",
		"expires_in": int(accessTTL.Seconds()),
	})
}

// refreshTokenFromRequest reads the refresh token a client is presenting, and
// reports whether it came from the body (native) rather than the cookie (web).
// Body wins when both are present.
func refreshTokenFromRequest(r *http.Request) (token string, native bool) {
	var body struct {
		Refresh string `json:"refresh"`
	}
	if r.Body != nil {
		// A web client sends no body at all; a decode failure here is normal.
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
	}
	if body.Refresh != "" {
		return body.Refresh, true
	}
	if cookie, err := r.Cookie(refreshCookieName); err == nil {
		return cookie.Value, false
	}
	return "", false
}

func refreshCookieSecure(r *http.Request) bool {
	return r.TLS != nil ||
		strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") ||
		strings.HasPrefix(os.Getenv("PUBLIC_URL"), "https://")
}

func setRefreshCookie(w http.ResponseWriter, r *http.Request, token string) {
	secure := refreshCookieSecure(r)
	sameSite := http.SameSiteLaxMode
	if secure {
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    token,
		Path:     "/auth",
		MaxAge:   int(refreshSessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
	})
}

func clearRefreshCookie(w http.ResponseWriter, r *http.Request) {
	secure := refreshCookieSecure(r)
	sameSite := http.SameSiteLaxMode
	if secure {
		sameSite = http.SameSiteNoneMode
	}
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     "/auth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
	})
}

// requireAccess pulls and verifies a Bearer access token. Returns the claims or an
// error (caller responds 401).
func (s *Server) requireAccess(r *http.Request) (*Claims, error) {
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, "Bearer ") {
		return nil, errors.New("missing bearer token")
	}
	c, err := s.auth.verify(strings.TrimPrefix(authz, "Bearer "))
	if err != nil {
		return nil, err
	}
	if c.Typ != "access" {
		return nil, errors.New("not an access token")
	}
	return c, nil
}

// GET /.well-known/jwks.json
func (s *Server) handleJWKS(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.auth.jwks())
}

// GET /auth/authorize?provider=&redirect_uri=&code_challenge=
func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	provider := r.URL.Query().Get("provider")
	redirectURI := r.URL.Query().Get("redirect_uri")
	challenge := r.URL.Query().Get("code_challenge")
	if provider == "" || redirectURI == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "provider and redirect_uri required"})
		return
	}
	if !isAllowedRedirectURI(redirectURI) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "redirect_uri not allowed"})
		return
	}
	if challenge == "" && !isLocalRedirectURI(redirectURI) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "code_challenge required"})
		return
	}
	target, err := s.oauth.startAuthorize(provider, redirectURI, challenge)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// GET /auth/github/callback?state=&code=
func (s *Server) handleGitHubCallback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	target, err := s.oauth.completeGitHub(r.Context(), state, code)
	if err != nil {
		if target != "" {
			http.Redirect(w, r, target, http.StatusFound)
			return
		}
		writeErrorResponse(w, http.StatusBadRequest, err)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// POST /auth/apple/callback (form-encoded: state, code)
//
// A POST, unlike GitHub's GET callback, because the authorize request sets
// `response_mode=form_post` — see authorizeURL for why it stays that way.
func (s *Server) handleAppleCallback(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeErrorResponse(w, http.StatusBadRequest, err)
		return
	}
	target, err := s.oauth.completeApple(r.Context(), r.FormValue("state"), r.FormValue("code"))
	if err != nil {
		if target != "" {
			http.Redirect(w, r, target, http.StatusFound)
			return
		}
		writeErrorResponse(w, http.StatusBadRequest, err)
		return
	}
	// 303, not 302: the browser arrived here with a POST, and a 302 would let it
	// replay that POST against the redirect target.
	http.Redirect(w, r, target, http.StatusSeeOther)
}

// POST /auth/token { code, code_verifier } -> short access token + refresh cookie.
func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code     string `json:"code"`
		Verifier string `json:"code_verifier"`
		// Set by the packaged app: return the refresh token in the response
		// instead of as a cookie it would never be able to send back.
		Native bool `json:"native"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad body"})
		return
	}
	userID, err := s.oauth.exchangeCode(body.Code, body.Verifier)
	if err != nil {
		writeErrorResponse(w, http.StatusBadRequest, err)
		return
	}
	access, err := s.auth.signAccess(userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "sign failed"})
		return
	}
	refresh, err := s.store.CreateRefreshSession(userID, refreshSessionTTL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session failed"})
		return
	}
	if body.Native {
		writeTokenPair(w, http.StatusOK, access, refresh)
		return
	}
	setRefreshCookie(w, r, refresh)
	writeAccessToken(w, http.StatusOK, access)
}

// POST /auth/refresh -> new short access token. The web client authenticates
// with its HttpOnly cookie; the native app posts `{"refresh": "…"}` instead.
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	token, native := refreshTokenFromRequest(r)
	if token == "" {
		if !native {
			clearRefreshCookie(w, r)
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing refresh session"})
		return
	}
	session, err := s.store.RotateRefreshSession(token, refreshSessionTTL)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "session failed"})
		return
	}
	if !session.OK {
		if session.ClearCookie && !native {
			clearRefreshCookie(w, r)
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid refresh session"})
		return
	}
	access, err := s.auth.signAccess(session.UserID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "sign failed"})
		return
	}
	if native {
		writeTokenPair(w, http.StatusOK, access, session.Token)
		return
	}
	setRefreshCookie(w, r, session.Token)
	writeAccessToken(w, http.StatusOK, access)
}

// POST /auth/logout revokes the current refresh session and clears its cookie.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if token, _ := refreshTokenFromRequest(r); token != "" {
		_ = s.store.RevokeRefreshSession(token)
	}
	clearRefreshCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// POST /auth/push/devices { token, platform } registers this phone for APNs
// (auth: access).
func (s *Server) handleRegisterPushDevice(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireAccess(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	var body struct {
		Token    string `json:"token"`
		Platform string `json:"platform"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || body.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token required"})
		return
	}
	// The platform decides which service the token is sent to, so an unknown
	// value would create a row that can never be delivered to. Default to iOS
	// only for clients predating the Android build.
	if body.Platform == "" {
		body.Platform = "ios"
	}
	if body.Platform != "ios" && body.Platform != "android" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported platform"})
		return
	}
	if err := s.store.UpsertPushDevice(claims.Subject, body.Token, body.Platform); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "register failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// DELETE /auth/push/devices { token } unregisters a phone (auth: access).
func (s *Server) handleDeletePushDevice(w http.ResponseWriter, r *http.Request) {
	if _, err := s.requireAccess(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || body.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token required"})
		return
	}
	if err := s.store.DeletePushDevice(body.Token); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "unregister failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// POST /agent/push delivers a notification to the owner's phones (auth: node).
//
// The node is the only party that knows a turn finished or a task moved, but it
// has no route to APNs — it reaches Apple through here. Node auth, not user
// auth: this is called by the desktop app, and it can only ever notify its own
// owner because the target user comes from the verified token, not the body.
func (s *Server) handleAgentPush(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireNode(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	if s.apns == nil && s.fcm == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": errPushNotConfigured.Error()})
		return
	}
	var msg PushMessage
	if err := json.NewDecoder(io.LimitReader(r.Body, 16384)).Decode(&msg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad body"})
		return
	}
	if msg.Title == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "title required"})
		return
	}
	// Answer immediately; APNs latency is not the node's problem, and the node
	// is inside a user-facing hot path (a chat turn finishing).
	go s.pushToUser(context.WithoutCancel(r.Context()), claims.Subject, msg)
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

// DELETE /auth/account permanently deletes the signed-in user (auth: access).
//
// App Store Guideline 5.1.1(v): an app offering account creation must offer
// account deletion from within the app. Deleting the account also strands every
// paired machine, so live tunnels are closed on the way out — otherwise a node
// would keep a working connection to an account that no longer exists.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireAccess(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}

	nodeIDs, err := s.store.ListNodeIDs(claims.Subject)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete failed"})
		return
	}
	if err := s.store.DeleteAccount(claims.Subject); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete failed"})
		return
	}
	for _, nodeID := range nodeIDs {
		if conn, ok := s.reg.Get(claims.Subject, nodeID); ok {
			conn.send(&Frame{T: FrameClose, Code: "revoked", Message: "account deleted"})
			conn.cancel()
		}
	}
	clearRefreshCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// POST /auth/nodes { label, nodeId? } -> { nodeId, nodeToken } (auth: access)
//
// If `nodeId` is supplied and still belongs to this user (and isn't revoked), the
// node is REUSED — we just re-sign a fresh token. This lets a desktop re-login on the
// same machine keep its node instead of stranding an orphaned, forever-offline one
// every time. An unknown/foreign/revoked id falls through to creating a new node.
func (s *Server) handleCreateNode(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireAccess(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	var body struct {
		Label  string `json:"label"`
		NodeID string `json:"nodeId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	nodeID := ""
	if body.NodeID != "" {
		if node, ok, gErr := s.store.GetNode(body.NodeID); gErr == nil && ok &&
			node.UserID == claims.Subject && node.RevokedAt == 0 {
			nodeID = node.ID
			if body.Label != "" && body.Label != node.Label {
				s.store.UpdateNodeLabel(nodeID, body.Label)
			}
		}
	}
	if nodeID == "" {
		nodeID, err = s.store.CreateNode(claims.Subject, body.Label)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "create failed"})
			return
		}
	}
	nodeToken, err := s.auth.signNode(claims.Subject, nodeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "sign failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"nodeId":    nodeID,
		"label":     body.Label,
		"nodeToken": nodeToken,
	})
}

// GET /auth/nodes -> user's nodes, merged with live online status (auth: access)
func (s *Server) handleListUserNodes(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireAccess(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	rows, err := s.store.ListNodes(claims.Subject)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "list failed"})
		return
	}
	type nodeView struct {
		NodeID  string `json:"nodeId"`
		Label   string `json:"label"`
		Online  bool   `json:"online"`
		Revoked bool   `json:"revoked"`
	}
	out := []nodeView{}
	for _, n := range rows {
		// Online if THIS instance owns the tunnel (fast path), or — in a cluster —
		// some peer owns it per the shared route directory. Without the directory
		// check a round-robined /auth/nodes flaps online/offline between the owner
		// and non-owner instances.
		_, online := s.reg.Get(claims.Subject, n.ID)
		if !online && s.dir.enabled() {
			online = s.dir.nodeOnline(r.Context(), claims.Subject, n.ID)
		}
		out = append(out, nodeView{NodeID: n.ID, Label: n.Label, Online: online, Revoked: n.RevokedAt != 0})
	}
	writeJSON(w, http.StatusOK, out)
}

// DELETE /auth/nodes/{id} -> revoke (auth: access). Also force-closes a live conn.
func (s *Server) handleRevokeNode(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireAccess(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	nodeID := r.PathValue("id")
	if err := s.store.RevokeNode(claims.Subject, nodeID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if conn, ok := s.reg.Get(claims.Subject, nodeID); ok {
		conn.send(&Frame{T: FrameClose, Code: "revoked", Message: "node revoked"})
		conn.cancel()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
