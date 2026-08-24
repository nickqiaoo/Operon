package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// oneReviewer is the single-account config most of these tests want.
func oneReviewer(username, password string) *reviewerConfig {
	return &reviewerConfig{accounts: []reviewerAccount{{username: username, password: password}}}
}

func TestReviewerDisabledWhenUnconfigured(t *testing.T) {
	t.Setenv("REVIEW_USERNAME", "")
	t.Setenv("REVIEW_PASSWORD", "")
	if newReviewerConfig() != nil {
		t.Fatal("review sign-in must stay off unless both variables are set")
	}

	// Half-configured is off too — a username with no password must never
	// degrade into "any password works".
	t.Setenv("REVIEW_USERNAME", "reviewer")
	if newReviewerConfig() != nil {
		t.Fatal("a username without a password must not enable review sign-in")
	}
}

// The reviewer deletes the first account to satisfy Guideline 5.1.1(v) and then
// needs a second one to carry on, so several pairs must resolve to several
// distinct accounts.
func TestReviewerConfigCollectsEveryConfiguredPair(t *testing.T) {
	t.Setenv("REVIEW_USERNAME", "reviewer-one")
	t.Setenv("REVIEW_PASSWORD", "password-one")
	t.Setenv("REVIEW_USERNAME_2", "reviewer-two")
	t.Setenv("REVIEW_PASSWORD_2", "password-two")

	c := newReviewerConfig()
	if c == nil {
		t.Fatal("config must be enabled when pairs are set")
	}
	if got := c.usernames(); len(got) != 2 || got[0] != "reviewer-one" || got[1] != "reviewer-two" {
		t.Fatalf("usernames = %v, want both accounts in order", got)
	}

	// Each pair matches only its own password: the accounts are separate, not a
	// pool of interchangeable credentials.
	for _, tc := range []struct {
		username, password string
		want               bool
	}{
		{"reviewer-one", "password-one", true},
		{"reviewer-two", "password-two", true},
		{"reviewer-one", "password-two", false},
		{"reviewer-two", "password-one", false},
		{"reviewer-three", "password-one", false},
	} {
		matched, ok := c.match(tc.username, tc.password)
		if ok != tc.want {
			t.Fatalf("match(%q, %q) = %v, want %v", tc.username, tc.password, ok, tc.want)
		}
		// The matched name is what keys the account, so a hit must report the
		// username that actually matched.
		if ok && matched != tc.username {
			t.Fatalf("match(%q, …) reported %q", tc.username, matched)
		}
	}
}

// A suffixed pair on its own still counts: the production compose file names
// every variable explicitly, and one forgotten line should not silently drop an
// account rather than enabling it.
func TestReviewerConfigAllowsGapsAndSkipsDuplicates(t *testing.T) {
	t.Setenv("REVIEW_USERNAME", "")
	t.Setenv("REVIEW_PASSWORD", "")
	t.Setenv("REVIEW_USERNAME_3", "reviewer-three")
	t.Setenv("REVIEW_PASSWORD_3", "password-three")

	c := newReviewerConfig()
	if c == nil || len(c.accounts) != 1 {
		t.Fatalf("config = %+v, want the suffixed pair alone", c)
	}

	// Two entries sharing a username are one account with two passwords, since
	// provider_sub is the username. The later one must not shadow the first.
	t.Setenv("REVIEW_USERNAME_4", "reviewer-three")
	t.Setenv("REVIEW_PASSWORD_4", "different-password")

	c = newReviewerConfig()
	if c == nil || len(c.accounts) != 1 {
		t.Fatalf("config = %+v, want the duplicate username dropped", c)
	}
	if _, ok := c.match("reviewer-three", "different-password"); ok {
		t.Fatal("the shadowed duplicate's password must not be accepted")
	}
	if _, ok := c.match("reviewer-three", "password-three"); !ok {
		t.Fatal("the first entry for a username must keep working")
	}
}

// Unconfigured, the endpoint must not admit it exists.
func TestReviewerLoginIs404WhenOff(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPost, "http://broker/auth/review", strings.NewReader(`{}`))
	w := httptest.NewRecorder()

	s.handleReviewerLogin(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestReviewerLoginRejectsBadCredentials(t *testing.T) {
	s := &Server{reviewer: oneReviewer("reviewer", "correct-horse-battery-staple")}

	for _, body := range []string{
		`{"username":"reviewer","password":"wrong","code_challenge":"c","redirect_uri":"operon://auth/callback"}`,
		`{"username":"someone-else","password":"correct-horse-battery-staple","code_challenge":"c","redirect_uri":"operon://auth/callback"}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "http://broker/auth/review", strings.NewReader(body))
		w := httptest.NewRecorder()

		s.handleReviewerLogin(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d for %s", w.Code, http.StatusUnauthorized, body)
		}
		var out map[string]string
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if out["code"] != "" {
			t.Fatal("a rejected sign-in must not return a code")
		}
	}
}

// PKCE is not optional here just because there is no browser redirect involved:
// without it, a code observed in transit would be redeemable on its own.
func TestReviewerLoginRequiresPKCEAndAnAllowedRedirect(t *testing.T) {
	t.Setenv("WEB_ORIGINS", "https://app.example.test")
	s := &Server{reviewer: oneReviewer("reviewer", "correct-horse-battery-staple")}

	cases := map[string]string{
		"no challenge":          `{"username":"reviewer","password":"correct-horse-battery-staple","redirect_uri":"operon://auth/callback"}`,
		"foreign redirect":      `{"username":"reviewer","password":"correct-horse-battery-staple","code_challenge":"c","redirect_uri":"https://evil.example/auth/callback"}`,
		"redirect omitted":      `{"username":"reviewer","password":"correct-horse-battery-staple","code_challenge":"c"}`,
		"not a redirect at all": `{"username":"reviewer","password":"correct-horse-battery-staple","code_challenge":"c","redirect_uri":"operon://evil"}`,
	}
	for name, body := range cases {
		req := httptest.NewRequest(http.MethodPost, "http://broker/auth/review", strings.NewReader(body))
		w := httptest.NewRecorder()

		s.handleReviewerLogin(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want %d", name, w.Code, http.StatusBadRequest)
		}
	}
}
