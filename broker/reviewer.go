package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"

	"io"
	"log/slog"
	"net/http"
	"os"
	"time"
)

// Password sign-in for App Store review, and for nothing else.
//
// operon signs in with GitHub or Apple only, which leaves an app-store reviewer
// with no way through:
//
//   - GitHub asks an unrecognised device for an emailed verification code. The
//     mail goes to the account owner, not the reviewer, so the review stops
//     there.
//   - Sign in with Apple works for him — with his own Apple ID, which by design
//     is a brand-new account with no paired machine. He lands on an empty list
//     and cannot evaluate anything.
//
// Both failures read to a reviewer as "the app does not work", which is a
// rejection. So there is a third door, opened only when REVIEW_USERNAME and
// REVIEW_PASSWORD are both set. The account it resolves to is an ordinary one
// (provider "review"), so it must be paired with a real, always-on machine
// beforehand — that pairing, not this endpoint, is what the reviewer actually
// needs.
//
// This is a real credential on a real account, not a bypass: it mints the same
// one-time code the OAuth callbacks do, and the caller still has to complete
// PKCE at /auth/token. Nothing here skips a step that the other providers take.
//
// # Why more than one
//
// Guideline 5.1.1(v) makes the reviewer delete an account from inside the app,
// and DeleteAccount is a hard delete — it takes the user's nodes with it (see
// Store.DeleteAccount). Signing back in with the same credentials works, because
// UpsertUser recreates the row, but it lands on a NEW user id with nothing
// paired: an empty machine list, and no way to carry on reviewing.
//
// That empty state is correct and worth showing — it is the visible proof the
// deletion was real, exactly as deleting and re-authorising with GitHub or Apple
// behaves. So the answer is not to make the account survive deletion; it is to
// hand the reviewer a second one. He deletes the first, confirms it is gone, and
// continues with the next.
//
// Each username is its own provider_sub, so the accounts are entirely separate,
// and each needs its own machine paired to it beforehand.
type reviewerAccount struct {
	username string
	password string
}

type reviewerConfig struct {
	accounts []reviewerAccount
}

// reviewerEnvSuffixes are scanned in order; the first is unsuffixed so a broker
// already deployed with REVIEW_USERNAME/REVIEW_PASSWORD keeps working untouched.
// Gaps are allowed — REVIEW_USERNAME_3 alone is fine — because the production
// compose file names every variable explicitly for both instances, and requiring
// them to be contiguous would turn one forgotten line into a silent downgrade to
// fewer accounts than intended.
var reviewerEnvSuffixes = []string{"", "_2", "_3", "_4"}

// newReviewerConfig returns nil when review sign-in isn't configured, which is
// the expected state everywhere except production.
func newReviewerConfig() *reviewerConfig {
	var accounts []reviewerAccount
	seen := map[string]bool{}
	for _, suffix := range reviewerEnvSuffixes {
		username := os.Getenv("REVIEW_USERNAME" + suffix)
		password := os.Getenv("REVIEW_PASSWORD" + suffix)
		// Half-configured is off, per pair: a username with no password must
		// never degrade into "any password works".
		if username == "" || password == "" {
			continue
		}
		// Two entries sharing a username are one account with two passwords —
		// they resolve to the same provider_sub — which silently defeats the
		// point of configuring a second one.
		if seen[username] {
			slog.Warn("review sign-in: duplicate username ignored", "username", username, "suffix", suffix)
			continue
		}
		seen[username] = true
		accounts = append(accounts, reviewerAccount{username: username, password: password})
	}
	if len(accounts) == 0 {
		return nil
	}
	return &reviewerConfig{accounts: accounts}
}

// match reports which configured account the credentials belong to.
//
// Every account is compared on every attempt — no early exit on the first hit —
// so the work done is the same whether the caller guessed the first username,
// the last, or none of them.
func (c *reviewerConfig) match(username, password string) (string, bool) {
	matched := ""
	for _, a := range c.accounts {
		userOK := subtle.ConstantTimeCompare([]byte(username), []byte(a.username)) == 1
		passOK := subtle.ConstantTimeCompare([]byte(password), []byte(a.password)) == 1
		if userOK && passOK {
			matched = a.username
		}
	}
	return matched, matched != ""
}

// usernames lists the configured accounts, for the startup log.
func (c *reviewerConfig) usernames() []string {
	out := make([]string, 0, len(c.accounts))
	for _, a := range c.accounts {
		out = append(out, a.username)
	}
	return out
}

type reviewerLoginRequest struct {
	Username      string `json:"username"`
	Password      string `json:"password"`
	CodeChallenge string `json:"code_challenge"`
	RedirectURI   string `json:"redirect_uri"`
}

// POST /auth/review — exchange reviewer credentials for a one-time code.
func (s *Server) handleReviewerLogin(w http.ResponseWriter, r *http.Request) {
	// 404 rather than 503 when unconfigured: an endpoint that announces its own
	// existence invites guessing at it.
	if s.reviewer == nil {
		http.NotFound(w, r)
		return
	}

	var req reviewerLoginRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad body"})
		return
	}
	// Same PKCE requirement every other provider carries. The code this mints is
	// worthless without the verifier, so a leaked code is not a leaked session.
	if req.CodeChallenge == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "code_challenge required"})
		return
	}
	if !isAllowedRedirectURI(req.RedirectURI) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "redirect_uri not allowed"})
		return
	}

	username, ok := s.reviewer.match(req.Username, req.Password)
	if !ok {
		// Deliberately slow. There is no lockout and no captcha here, so this
		// delay is the whole brute-force defence — pick a long password.
		time.Sleep(time.Second)
		slog.Warn("review sign-in rejected", "remote", r.RemoteAddr)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	// A distinct provider, so this can never collide with a GitHub or Apple
	// subject and the account is visible for what it is. Keyed on the matched
	// username, which is what keeps the configured accounts separate.
	userID, err := s.store.UpsertUser("review", username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "sign-in failed"})
		return
	}

	code := randToken()
	if err := s.oauth.putCode(context.Background(), code, &pendingCode{
		UserID:      userID,
		Challenge:   req.CodeChallenge,
		RedirectURI: req.RedirectURI,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "sign-in failed"})
		return
	}
	slog.Info("review sign-in accepted", "user", userID)
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}
