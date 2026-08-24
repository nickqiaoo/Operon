package main

import (
	"errors"
	"net/http"
)

const (
	brokerErrorNodeOffline        = "node_offline"
	brokerErrorGitHubOAuthTimeout = "github_oauth_timeout"
)

const githubOAuthTimeoutMessage = "GitHub sign-in timed out while the broker was contacting GitHub. Please try again. If you are in mainland China, switch networks or use a proxy and retry."

type codedBrokerError struct {
	code    string
	message string
	err     error
}

func (e *codedBrokerError) Error() string {
	if e.err != nil {
		return e.err.Error()
	}
	return e.message
}

func (e *codedBrokerError) Unwrap() error {
	return e.err
}

func newCodedBrokerError(code, message string, err error) error {
	return &codedBrokerError{code: code, message: message, err: err}
}

func brokerErrorDetails(err error) (code string, message string, ok bool) {
	var coded *codedBrokerError
	if errors.As(err, &coded) {
		return coded.code, coded.message, true
	}
	return "", "", false
}

func writeBrokerError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("X-Operon-Error-Code", code)
	writeJSON(w, status, map[string]string{
		"error":   code,
		"code":    code,
		"message": message,
	})
}

func writeErrorResponse(w http.ResponseWriter, status int, err error) {
	if code, message, ok := brokerErrorDetails(err); ok {
		if code == brokerErrorGitHubOAuthTimeout {
			status = http.StatusGatewayTimeout
		}
		writeBrokerError(w, status, code, message)
		return
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeNodeOffline(w http.ResponseWriter) {
	writeBrokerError(
		w,
		http.StatusServiceUnavailable,
		brokerErrorNodeOffline,
		"The selected machine is offline. Open operon on that machine and try again.",
	)
}

func newGitHubOAuthTimeoutError(err error) error {
	return newCodedBrokerError(brokerErrorGitHubOAuthTimeout, githubOAuthTimeoutMessage, err)
}
