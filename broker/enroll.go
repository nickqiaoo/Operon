package main

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Enrollment brings a machine with no browser (a Linux server running the headless
// node) into an account. Desktop login is loopback OAuth, which needs a browser on
// the same machine; a server has none. Instead, a machine that is already signed in
// asks for a one-time code, shows it, and the server redeems it for its own node.
//
// The code stands in for a login, so it is short-lived, single-use (an atomic take
// from the ephemeral KV, which is Redis when clustered) and 80 random bits. Minting
// it takes a NODE token, not an access token: the desktop's access token expires
// after accessTTL and is never refreshed, while its node token lives as long as the
// machine stays signed in.

const enrollCodeTTL = 5 * time.Minute

var enrollEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

func newEnrollCode() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return enrollEncoding.EncodeToString(b)
}

func normalizeEnrollCode(code string) string {
	return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(code)))
}

func enrollKey(code string) string { return "enroll:" + code }

// POST /agent/enroll (auth: node) -> { code, expiresAt }
func (s *Server) handleCreateEnrollCode(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireNode(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if _, active := s.delegationNode(claims.Subject, claims.NodeID); !active {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	code := newEnrollCode()
	if err := s.oauth.kv.put(r.Context(), enrollKey(code), claims.Subject, enrollCodeTTL); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":      code,
		"expiresAt": time.Now().Add(enrollCodeTTL).UnixMilli(),
	})
}

// POST /auth/nodes/enroll/redeem { code, label, nodeId? } -> { userId, nodeId, label, nodeToken }
//
// No auth: the code is the credential. `nodeId` reuses the machine's node from an
// earlier enrollment into the same account, as handleCreateNode does for a desktop
// re-login, so enrolling a server twice does not leave a dead node behind.
func (s *Server) handleRedeemEnrollCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code   string `json:"code"`
		Label  string `json:"label"`
		NodeID string `json:"nodeId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad body"})
		return
	}
	code := normalizeEnrollCode(body.Code)
	if code == "" {
		writeBrokerError(w, http.StatusBadRequest, "enroll_code_invalid", "The code is missing.")
		return
	}
	userID, ok, err := s.oauth.kv.take(r.Context(), enrollKey(code))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "store failed"})
		return
	}
	if !ok || userID == "" {
		writeBrokerError(w, http.StatusNotFound, "enroll_code_invalid", "This code is wrong, expired or already used. Get a new one on a signed-in machine.")
		return
	}

	nodeID := ""
	if body.NodeID != "" {
		if node, found, gErr := s.store.GetNode(body.NodeID); gErr == nil && found && node.UserID == userID && node.RevokedAt == 0 {
			nodeID = node.ID
			if body.Label != "" && body.Label != node.Label {
				s.store.UpdateNodeLabel(nodeID, body.Label)
			}
		}
	}
	if nodeID == "" {
		nodeID, err = s.store.CreateNode(userID, body.Label)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "create failed"})
			return
		}
	}
	nodeToken, err := s.auth.signNode(userID, nodeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "sign failed"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{
		"userId":    userID,
		"nodeId":    nodeID,
		"label":     body.Label,
		"nodeToken": nodeToken,
	})
}

// DELETE /agent/self (auth: node) — a node signing itself out. A headless node holds
// no access token (it never logged in through a browser), so this is the only way it
// can take itself off the account rather than just forgetting its token locally.
func (s *Server) handleRevokeSelf(w http.ResponseWriter, r *http.Request) {
	claims, err := s.requireNode(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if err := s.store.RevokeNode(claims.Subject, claims.NodeID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if conn, ok := s.reg.Get(claims.Subject, claims.NodeID); ok {
		conn.send(&Frame{T: FrameClose, Code: "revoked", Message: "node signed out"})
		conn.cancel()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
