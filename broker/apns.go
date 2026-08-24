package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// APNs sender (token-based / HTTP2).
//
// This is the outbound half of the app's notifications: the desktop node is
// what actually notices "the agent finished" — the broker only knows how to
// reach the user's phones. The node posts to /agent/push with its node token
// and this fans the message out to that user's registered devices.
//
// Nothing here is required for the app to function; a broker with no APNs
// credentials configured just logs and returns.

const (
	apnsProdHost    = "https://api.push.apple.com"
	apnsSandboxHost = "https://api.sandbox.push.apple.com"
	// Apple rejects a provider token younger than 20 minutes when it is
	// regenerated too eagerly, and refuses one older than 60. Refresh in the
	// middle of that window.
	apnsTokenTTL = 40 * time.Minute
	// How long an undelivered notification stays worth delivering. Shared with
	// FCM so both platforms age out together.
	pushExpiry = time.Hour
	// APNs caps the collapse-id at 64 bytes and fails the request over it.
	maxCollapseIDLen = 64
)

// collapseID makes a source key safe to use as a collapse identifier. Keys are
// short and ASCII ('chat:42'), so this only ever guards against a future one
// that isn't.
func collapseID(sourceKey string) string {
	if len(sourceKey) > maxCollapseIDLen {
		return sourceKey[:maxCollapseIDLen]
	}
	return sourceKey
}

type apnsConfig struct {
	teamID   string
	keyID    string
	bundleID string
	host     string
	key      *ecdsa.PrivateKey

	client *http.Client

	mu          sync.Mutex
	cachedToken string
	cachedAt    time.Time
}

// newAPNsConfig returns nil when push isn't configured. APPLE_TEAM_ID is shared
// with Sign in with Apple; the key is a *different* .p8 (an APNs key, not a
// Sign in with Apple key) and they are not interchangeable.
func newAPNsConfig() (*apnsConfig, error) {
	keyID := os.Getenv("APNS_KEY_ID")
	rawKey := os.Getenv("APNS_PRIVATE_KEY")
	bundleID := os.Getenv("APNS_BUNDLE_ID")
	teamID := os.Getenv("APNS_TEAM_ID")
	if teamID == "" {
		teamID = os.Getenv("APPLE_TEAM_ID")
	}
	if keyID == "" || rawKey == "" || bundleID == "" || teamID == "" {
		return nil, nil
	}
	key, err := parseAppleKey(rawKey)
	if err != nil {
		return nil, fmt.Errorf("APNS_PRIVATE_KEY: %w", err)
	}
	host := apnsProdHost
	if os.Getenv("APNS_ENVIRONMENT") == "sandbox" {
		host = apnsSandboxHost
	}
	return &apnsConfig{
		teamID:   teamID,
		keyID:    keyID,
		bundleID: bundleID,
		host:     host,
		key:      key,
		// The default transport negotiates HTTP/2 over ALPN, which APNs requires.
		client: &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// providerToken returns the cached ES256 bearer token, minting a new one when
// the old one is past its refresh window.
func (a *apnsConfig) providerToken() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cachedToken != "" && time.Since(a.cachedAt) < apnsTokenTTL {
		return a.cachedToken, nil
	}

	now := time.Now()
	header, err := json.Marshal(map[string]string{"alg": "ES256", "kid": a.keyID})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]interface{}{"iss": a.teamID, "iat": now.Unix()})
	if err != nil {
		return "", err
	}
	signingInput := b64url(header) + "." + b64url(claims)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, a.key, digest[:])
	if err != nil {
		return "", err
	}
	size := (a.key.Curve.Params().BitSize + 7) / 8
	sig := make([]byte, 2*size)
	copyPadded(sig[:size], r)
	copyPadded(sig[size:], s)

	a.cachedToken = signingInput + "." + b64url(sig)
	a.cachedAt = now
	return a.cachedToken, nil
}

// PushMessage is what a node asks the broker to deliver.
type PushMessage struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	// The inbox row's coalescing key ('chat:42'). Used as the APNs collapse-id
	// and the FCM collapse_key so a source that fires twice replaces its own
	// banner instead of stacking a second one. Optional: an older node that
	// doesn't send it just gets uncollapsed behaviour.
	SourceKey string `json:"sourceKey,omitempty"`
	// Deep-link target, echoed back to the app so tapping the notification can
	// open the right conversation or task. Project/workspace ride along because
	// the phone has to switch context before it can open either.
	ChatID      int64  `json:"chatId,omitempty"`
	TaskID      int64  `json:"taskId,omitempty"`
	ProjectID   int64  `json:"projectId,omitempty"`
	WorkspaceID int64  `json:"workspaceId,omitempty"`
	Kind        string `json:"kind,omitempty"`
}

// send delivers one message to one device. It reports whether the token is dead
// and should be forgotten.
func (a *apnsConfig) send(ctx context.Context, deviceToken string, msg PushMessage) (dead bool, err error) {
	token, err := a.providerToken()
	if err != nil {
		return false, err
	}

	payload := map[string]interface{}{
		"aps": map[string]interface{}{
			"alert": map[string]string{"title": msg.Title, "body": msg.Body},
			"sound": "default",
		},
	}
	if msg.ChatID != 0 {
		payload["chatId"] = msg.ChatID
	}
	if msg.TaskID != 0 {
		payload["taskId"] = msg.TaskID
	}
	if msg.ProjectID != 0 {
		payload["projectId"] = msg.ProjectID
	}
	if msg.WorkspaceID != 0 {
		payload["workspaceId"] = msg.WorkspaceID
	}
	if msg.Kind != "" {
		payload["kind"] = msg.Kind
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return false, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.host+"/3/device/"+deviceToken, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("authorization", "bearer "+token)
	req.Header.Set("apns-topic", a.bundleID)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("content-type", "application/json")
	// Without an explicit expiration APNs delivers once and never stores, so a
	// phone that happens to be offline loses the notification outright. An hour
	// is the useful life of "the agent is waiting for you": long enough to
	// survive a tunnel or a subway ride, short enough that yesterday's stalled
	// turn doesn't buzz on the way to work.
	req.Header.Set("apns-expiration", strconv.FormatInt(time.Now().Add(pushExpiry).Unix(), 10))
	if id := collapseID(msg.SourceKey); id != "" {
		req.Header.Set("apns-collapse-id", id)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode == http.StatusOK {
		return false, nil
	}

	var apnsErr struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(respBody, &apnsErr)
	// 410 Gone means the app was uninstalled; BadDeviceToken means it was never
	// valid for this environment. Both are permanent — drop the row rather than
	// retrying this device forever.
	dead = resp.StatusCode == http.StatusGone ||
		apnsErr.Reason == "BadDeviceToken" ||
		apnsErr.Reason == "Unregistered"
	return dead, fmt.Errorf("apns %d: %s", resp.StatusCode, apnsErr.Reason)
}

// pushToUser fans a message out to every device a user has registered, routing
// each to the service its token belongs to and pruning the ones reported dead.
// Best-effort: a push failure must never fail the caller's request.
//
// A user with both an iPhone and an Android phone gets both, and configuring
// only one of the two services leaves the other platform's devices silently
// skipped rather than erroring.
func (s *Server) pushToUser(ctx context.Context, userID string, msg PushMessage) {
	if s.apns == nil && s.fcm == nil {
		return
	}
	devices, err := s.store.ListPushDevices(userID)
	if err != nil {
		slog.Error("push: list devices failed", "err", err)
		return
	}
	for _, device := range devices {
		var dead bool
		var sendErr error
		switch device.Platform {
		case "android":
			if s.fcm == nil {
				continue
			}
			dead, sendErr = s.fcm.send(ctx, device.Token, msg)
		case "ios":
			if s.apns == nil {
				continue
			}
			dead, sendErr = s.apns.send(ctx, device.Token, msg)
		default:
			slog.Warn("push: unknown device platform", "platform", device.Platform)
			continue
		}

		if dead {
			if delErr := s.store.DeletePushDevice(device.Token); delErr != nil {
				slog.Error("push: prune device failed", "err", delErr)
			}
			continue
		}
		if sendErr != nil {
			slog.Warn("push: delivery failed", "platform", device.Platform, "err", sendErr)
		}
	}
}

var errPushNotConfigured = errors.New("push notifications not configured")
