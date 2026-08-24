package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Firebase Cloud Messaging (Android), the counterpart to apns.go.
//
// Same job, different handshake, and the difference is why this is a separate
// file rather than a branch inside the APNs sender:
//
//   - APNs is authenticated per request by an ES256 JWT the broker signs itself.
//   - FCM wants a Google OAuth2 access token, which is obtained by signing an
//     RS256 JWT with a service-account key and *exchanging* it at Google's token
//     endpoint. That is a network round-trip, so the result is cached.
//
// Credentials come from a service-account JSON key (Firebase console →
// project settings → service accounts). Without one, push on Android is simply
// unavailable and the rest of the broker is unaffected.

const (
	googleTokenURL  = "https://oauth2.googleapis.com/token"
	fcmScope        = "https://www.googleapis.com/auth/firebase.messaging"
	fcmTokenSkew    = 60 * time.Second
	fcmAssertionTTL = time.Hour
)

type fcmConfig struct {
	projectID   string
	clientEmail string
	key         *rsa.PrivateKey

	client *http.Client

	mu          sync.Mutex
	accessToken string
	expiresAt   time.Time
}

// serviceAccount is the subset of a Google service-account JSON key we need.
type serviceAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
}

// newFCMConfig returns nil when Android push isn't configured.
//
// FCM_SERVICE_ACCOUNT holds the service-account JSON itself. Some deployment
// UIs mangle the embedded newlines in `private_key`, so escaped `\n` is
// tolerated the same way the Apple key loader tolerates it.
func newFCMConfig() (*fcmConfig, error) {
	raw := strings.TrimSpace(os.Getenv("FCM_SERVICE_ACCOUNT"))
	if raw == "" {
		return nil, nil
	}
	var account serviceAccount
	if err := json.Unmarshal([]byte(raw), &account); err != nil {
		return nil, fmt.Errorf("FCM_SERVICE_ACCOUNT: not valid JSON: %w", err)
	}
	if account.ProjectID == "" || account.ClientEmail == "" || account.PrivateKey == "" {
		return nil, errors.New("FCM_SERVICE_ACCOUNT: missing project_id, client_email or private_key")
	}
	key, err := parseRSAPrivateKey(account.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("FCM_SERVICE_ACCOUNT private_key: %w", err)
	}
	return &fcmConfig{
		projectID:   account.ProjectID,
		clientEmail: account.ClientEmail,
		key:         key,
		client:      &http.Client{Timeout: 10 * time.Second},
	}, nil
}

func parseRSAPrivateKey(raw string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(strings.ReplaceAll(raw, `\n`, "\n")))
	if block == nil {
		return nil, errors.New("not a PEM block")
	}
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("not an RSA key")
		}
		return rsaKey, nil
	}
	// Older keys are emitted as PKCS#1.
	return x509.ParsePKCS1PrivateKey(block.Bytes)
}

// accessTokenFor returns a cached Google OAuth2 access token, refreshing it
// shortly before expiry.
func (f *fcmConfig) accessTokenFor(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.accessToken != "" && time.Now().Add(fcmTokenSkew).Before(f.expiresAt) {
		return f.accessToken, nil
	}

	assertion, err := f.signedAssertion()
	if err != nil {
		return "", err
	}
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	form.Set("assertion", assertion)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, googleTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := f.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("google token exchange failed (%d)", resp.StatusCode)
	}
	var token struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &token); err != nil {
		return "", err
	}
	if token.AccessToken == "" {
		return "", errors.New("google returned no access token")
	}
	f.accessToken = token.AccessToken
	f.expiresAt = time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)
	return f.accessToken, nil
}

// signedAssertion builds the RS256 JWT that is traded for an access token.
func (f *fcmConfig) signedAssertion() (string, error) {
	now := time.Now()
	header, err := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]interface{}{
		"iss":   f.clientEmail,
		"scope": fcmScope,
		"aud":   googleTokenURL,
		"iat":   now.Unix(),
		"exp":   now.Add(fcmAssertionTTL).Unix(),
	})
	if err != nil {
		return "", err
	}
	signingInput := b64url(header) + "." + b64url(claims)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + b64url(signature), nil
}

// send delivers one message to one device, reporting whether the token is dead
// and should be forgotten. Mirrors apnsConfig.send.
func (f *fcmConfig) send(ctx context.Context, deviceToken string, msg PushMessage) (dead bool, err error) {
	token, err := f.accessTokenFor(ctx)
	if err != nil {
		return false, err
	}

	// FCM requires every value in `data` to be a string, unlike the APNs
	// payload where they can be numbers.
	data := map[string]string{}
	if msg.ChatID != 0 {
		data["chatId"] = fmt.Sprint(msg.ChatID)
	}
	if msg.TaskID != 0 {
		data["taskId"] = fmt.Sprint(msg.TaskID)
	}
	if msg.ProjectID != 0 {
		data["projectId"] = fmt.Sprint(msg.ProjectID)
	}
	if msg.WorkspaceID != 0 {
		data["workspaceId"] = fmt.Sprint(msg.WorkspaceID)
	}
	if msg.Kind != "" {
		data["kind"] = msg.Kind
	}

	// Same two behaviours as the APNs headers: repeats of one source replace
	// their own notification, and an undelivered one stops being worth
	// delivering after an hour. FCM wants the TTL as a duration string, not a
	// timestamp — and it rejects an *empty* collapse_key with INVALID_ARGUMENT,
	// which send() would then misread as a dead device token and prune the
	// phone. So it goes in only when there is one.
	android := map[string]interface{}{
		"priority": "high",
		"ttl":      fmt.Sprintf("%ds", int(pushExpiry.Seconds())),
	}
	if id := collapseID(msg.SourceKey); id != "" {
		android["collapse_key"] = id
	}

	payload := map[string]interface{}{
		"message": map[string]interface{}{
			"token": deviceToken,
			"notification": map[string]string{
				"title": msg.Title,
				"body":  msg.Body,
			},
			"data":    data,
			"android": android,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return false, err
	}

	endpoint := "https://fcm.googleapis.com/v1/projects/" + f.projectID + "/messages:send"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := f.client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode == http.StatusOK {
		return false, nil
	}

	var fcmErr struct {
		Error struct {
			Status  string `json:"status"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(respBody, &fcmErr)
	// UNREGISTERED means the app was uninstalled; INVALID_ARGUMENT on a send is
	// almost always a malformed token. Both are permanent for this device.
	dead = resp.StatusCode == http.StatusNotFound ||
		fcmErr.Error.Status == "UNREGISTERED" ||
		fcmErr.Error.Status == "INVALID_ARGUMENT"
	return dead, fmt.Errorf("fcm %d: %s %s", resp.StatusCode, fcmErr.Error.Status, fcmErr.Error.Message)
}
