package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestWriteNodeOfflineEnvelope(t *testing.T) {
	w := httptest.NewRecorder()

	writeNodeOffline(w)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
	if got := w.Header().Get("X-Operon-Error-Code"); got != brokerErrorNodeOffline {
		t.Fatalf("error header = %q, want %q", got, brokerErrorNodeOffline)
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json", ct)
	}

	var body struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Error != brokerErrorNodeOffline || body.Code != brokerErrorNodeOffline {
		t.Fatalf("body = %+v, want node_offline code", body)
	}
	if body.Message == "" {
		t.Fatal("message should be present")
	}
}

func TestWriteCodedErrorEnvelope(t *testing.T) {
	w := httptest.NewRecorder()
	err := newGitHubOAuthTimeoutError(contextDeadlineExceededForTest{})

	writeErrorResponse(w, http.StatusGatewayTimeout, err)

	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusGatewayTimeout)
	}
	if got := w.Header().Get("X-Operon-Error-Code"); got != brokerErrorGitHubOAuthTimeout {
		t.Fatalf("error header = %q, want %q", got, brokerErrorGitHubOAuthTimeout)
	}

	var body struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Error != brokerErrorGitHubOAuthTimeout || body.Code != brokerErrorGitHubOAuthTimeout {
		t.Fatalf("body = %+v, want github timeout code", body)
	}
	if body.Message != githubOAuthTimeoutMessage {
		t.Fatalf("message = %q, want %q", body.Message, githubOAuthTimeoutMessage)
	}
}

type contextDeadlineExceededForTest struct{}

func (contextDeadlineExceededForTest) Error() string {
	return "context deadline exceeded"
}

func TestOAuthErrorRedirectCarriesBusinessCode(t *testing.T) {
	target := oauthErrorRedirect("http://127.0.0.1:53421/callback", newGitHubOAuthTimeoutError(contextDeadlineExceededForTest{}))
	u, err := url.Parse(target)
	if err != nil {
		t.Fatalf("parse redirect: %v", err)
	}

	if got := u.Query().Get("error_code"); got != brokerErrorGitHubOAuthTimeout {
		t.Fatalf("error_code = %q, want %q", got, brokerErrorGitHubOAuthTimeout)
	}
	if got := u.Query().Get("error"); got != brokerErrorGitHubOAuthTimeout {
		t.Fatalf("error = %q, want %q", got, brokerErrorGitHubOAuthTimeout)
	}
	if got := u.Query().Get("message"); got != githubOAuthTimeoutMessage {
		t.Fatalf("message = %q, want %q", got, githubOAuthTimeoutMessage)
	}
}
