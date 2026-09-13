package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Webhook entry points for Linear and GitHub. The broker verifies the
// signature, dedups the delivery, works out which user and node the event
// belongs to (person first, then machine — design.md §5.2), and pushes it
// down that node's tunnel as an ordinary req frame it never waits on. A node
// that is offline gets the event queued for a while.

const (
	webhookPathLinear = "/api/integrations/events/linear"
	webhookPathGitHub = "/api/integrations/events/github"
	deliveryRetention = 7 * 24 * time.Hour
)

// The headers only the broker sets on a forwarded webhook. handleProxy strips
// the same names off client traffic so a browser cannot forge an event.
var brokerOnlyHeaders = []string{
	"x-operon-origin", "x-operon-webhook-event", "x-operon-webhook-delivery",
	"x-operon-route-reason", "x-operon-actor",
}

func isBrokerOnlyHeader(lk string) bool {
	for _, h := range brokerOnlyHeaders {
		if lk == h {
			return true
		}
	}
	return false
}

func verifyHMACHex(secret string, body []byte, sig string) bool {
	if secret == "" || sig == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(strings.ToLower(sig)), []byte(want)) == 1
}

// --- routing (pure: testable without Postgres) ---

type routeDecision struct {
	UserID string
	NodeID string
	// Which lookup decided the user: session | issue | creator | installer | pr.
	Reason string
	// owner | other | unknown — whether the person who triggered the event is
	// the user the event routes to (design.md §8.5).
	Actor string
}

type routeLookup interface {
	FindRoute(kind, key string) (RouteRow, bool, error)
	GetLinearIdentity(orgID, linearUserID string) (LinearIdentityRow, bool, error)
	GetLinearIdentityByUser(orgID, userID string) (LinearIdentityRow, bool, error)
	GetLinearInstall(orgID string) (LinearInstallRow, bool, error)
	UserByGitHubLogin(login string) (string, bool, error)
}

type linearEventKeys struct {
	OrgID     string
	SessionID string
	IssueID   string
	// The Linear user who triggered this delivery.
	ActorID string
}

func actorOf(triggerUser, chosen string) string {
	switch {
	case triggerUser == "":
		return "unknown"
	case triggerUser == chosen:
		return "owner"
	default:
		return "other"
	}
}

// routeLinear: person first (sticky session → sticky issue → creator's
// identity → installer), then that person's machine (sticky → the node they
// linked from → any online node). Which repository the work belongs to is not
// a routing concern: the desktop reads it off the issue's `repo:` label.
func routeLinear(db routeLookup, k linearEventKeys, onlineNodes func(userID string) []string) (routeDecision, bool, error) {
	var d routeDecision
	triggerUser := ""
	if k.ActorID != "" {
		if id, ok, err := db.GetLinearIdentity(k.OrgID, k.ActorID); err != nil {
			return d, false, err
		} else if ok {
			triggerUser = id.UserID
		}
	}
	// A. the person
	var sticky *RouteRow
	if k.SessionID != "" {
		if r, ok, err := db.FindRoute("linear_session", k.SessionID); err != nil {
			return d, false, err
		} else if ok {
			d.UserID, d.Reason, sticky = r.UserID, "session", &r
		}
	}
	if d.UserID == "" && k.IssueID != "" {
		if r, ok, err := db.FindRoute("linear_issue", k.IssueID); err != nil {
			return d, false, err
		} else if ok {
			d.UserID, d.Reason, sticky = r.UserID, "issue", &r
		}
	}
	if d.UserID == "" && triggerUser != "" {
		d.UserID, d.Reason = triggerUser, "creator"
	}
	if d.UserID == "" {
		install, ok, err := db.GetLinearInstall(k.OrgID)
		if err != nil {
			return d, false, err
		}
		if !ok || install.RevokedAt != 0 {
			return d, false, nil
		}
		d.UserID, d.Reason = install.InstalledByUserID, "installer"
	}
	d.Actor = actorOf(triggerUser, d.UserID)

	// B. the machine
	if sticky != nil {
		d.NodeID = sticky.NodeID
		return d, true, nil
	}
	if id, ok, err := db.GetLinearIdentityByUser(k.OrgID, d.UserID); err != nil {
		return d, false, err
	} else if ok && id.DefaultNodeID != "" {
		d.NodeID = id.DefaultNodeID
		return d, true, nil
	}
	if nodes := onlineNodes(d.UserID); len(nodes) > 0 {
		d.NodeID = nodes[0]
		return d, true, nil
	}
	return d, false, nil
}

type githubEventKeys struct {
	Repo   string // owner/name
	Number int64  // PR number, 0 when none
	Sender string // login
}

// routeGitHub: only pull requests operon opened are interesting, and those
// carry a sticky github_pr row written by the desktop that opened them. The
// row names both the person and the machine; the sender is looked up just to
// tell the owner's comments from a teammate's.
func routeGitHub(db routeLookup, k githubEventKeys) (routeDecision, bool, error) {
	var d routeDecision
	if k.Number <= 0 || k.Repo == "" {
		return d, false, nil
	}
	r, ok, err := db.FindRoute("github_pr", k.Repo+"#"+strconv.FormatInt(k.Number, 10))
	if err != nil || !ok {
		return d, false, err
	}
	triggerUser := ""
	if k.Sender != "" {
		if uid, ok, err := db.UserByGitHubLogin(k.Sender); err != nil {
			return d, false, err
		} else if ok {
			triggerUser = uid
		}
	}
	d.UserID, d.NodeID, d.Reason = r.UserID, r.NodeID, "pr"
	d.Actor = actorOf(triggerUser, d.UserID)
	return d, true, nil
}

// --- payload parsing ---

// pick walks a JSON object along a dotted path and returns the string at the end.
func pick(m map[string]any, path string) string {
	cur := any(m)
	for _, seg := range strings.Split(path, ".") {
		obj, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = obj[seg]
	}
	switch v := cur.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatInt(int64(v), 10)
	case bool:
		return strconv.FormatBool(v)
	}
	return ""
}

func pickInt(m map[string]any, path string) int64 {
	n, _ := strconv.ParseInt(pick(m, path), 10, 64)
	return n
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func linearKeysOf(event string, p map[string]any) (linearEventKeys, bool) {
	k := linearEventKeys{OrgID: pick(p, "organizationId")}
	switch event {
	case "AgentSessionEvent":
		k.SessionID = pick(p, "agentSession.id")
		k.IssueID = pick(p, "agentSession.issue.id")
		// Who spoke: for a reply, the activity's author; for a fresh session,
		// its creator. The paths are the ones Linear documents plus the
		// likely variants — §18 item 10 verifies against a live payload.
		k.ActorID = firstNonEmpty(
			pick(p, "agentActivity.sourceComment.user.id"),
			pick(p, "agentActivity.sourceComment.userId"),
			pick(p, "agentActivity.user.id"),
			pick(p, "agentActivity.creator.id"),
			pick(p, "agentSession.creator.id"),
			pick(p, "agentSession.creatorId"),
			pick(p, "actor.id"),
		)
		return k, k.OrgID != "" && k.SessionID != ""
	case "Issue":
		k.IssueID = pick(p, "data.id")
		k.ActorID = pick(p, "actor.id")
		return k, k.OrgID != "" && k.IssueID != ""
	case "Comment":
		// A plain issue comment (not an agent-session reply): mirrored into the
		// task's activity feed on the owning node.
		k.IssueID = firstNonEmpty(pick(p, "data.issueId"), pick(p, "data.issue.id"))
		k.ActorID = firstNonEmpty(pick(p, "data.userId"), pick(p, "data.user.id"), pick(p, "actor.id"))
		return k, k.OrgID != "" && k.IssueID != ""
	}
	return k, false
}

// POST /webhooks/linear
func (s *Server) handleLinearWebhook(w http.ResponseWriter, r *http.Request) {
	c := s.integrations
	if c == nil || c.linearWebhookSecret == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if !verifyHMACHex(c.linearWebhookSecret, body, r.Header.Get("Linear-Signature")) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	event := firstNonEmpty(r.Header.Get("Linear-Event"), pick(payload, "type"))
	delivery := firstNonEmpty(r.Header.Get("Linear-Delivery"), pick(payload, "webhookId"))
	// Linear wants a 200 within seconds; everything below is bookkeeping and a
	// channel send, never a wait on the desktop.
	w.WriteHeader(http.StatusOK)

	if delivery != "" {
		if fresh, err := s.store.MarkDelivery("linear:" + delivery); err != nil {
			slog.Warn("linear webhook dedup failed", "err", err)
		} else if !fresh {
			return
		}
	}
	keys, ok := linearKeysOf(event, payload)
	if !ok {
		return
	}
	if event == "Issue" || event == "Comment" {
		// Only issues a task is already attached to are interesting; the rest of
		// the workspace's issue traffic is noise for every node.
		if _, tracked, _ := s.store.FindRoute("linear_issue", keys.IssueID); !tracked {
			return
		}
	}
	d, routed, err := routeLinear(s.store, keys, s.onlineNodeIDs)
	if err != nil {
		slog.Warn("linear webhook route failed", "err", err, "delivery", delivery)
		return
	}
	if !routed {
		slog.Info("linear webhook unrouted", "org", keys.OrgID, "event", event, "delivery", delivery)
		return
	}
	if event == "AgentSessionEvent" && pick(payload, "action") == "created" {
		_ = s.store.ClaimRoute(d.UserID, "linear_session", keys.SessionID, d.NodeID)
		if keys.IssueID != "" {
			_ = s.store.ClaimRoute(d.UserID, "linear_issue", keys.IssueID, d.NodeID)
		}
	}
	headers := map[string][]string{
		"content-type":              {"application/json"},
		"x-operon-origin":           {"webhook"},
		"x-operon-webhook-event":    {event},
		"x-operon-webhook-delivery": {delivery},
		"x-operon-route-reason":     {d.Reason},
		"x-operon-actor":            {d.Actor},
	}
	s.deliverWebhook(d.UserID, d.NodeID, "linear:"+delivery, webhookPathLinear, headers, body)
}

// POST /webhooks/github
func (s *Server) handleGitHubWebhook(w http.ResponseWriter, r *http.Request) {
	c := s.integrations
	if c == nil || c.githubWebhookSecret == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	sig := strings.TrimPrefix(r.Header.Get("X-Hub-Signature-256"), "sha256=")
	if !verifyHMACHex(c.githubWebhookSecret, body, sig) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	event := r.Header.Get("X-GitHub-Event")
	delivery := r.Header.Get("X-GitHub-Delivery")
	w.WriteHeader(http.StatusOK)

	if delivery != "" {
		if fresh, err := s.store.MarkDelivery("github:" + delivery); err != nil {
			slog.Warn("github webhook dedup failed", "err", err)
		} else if !fresh {
			return
		}
	}
	installationID := pickInt(payload, "installation.id")
	action := pick(payload, "action")

	switch event {
	case "installation":
		s.consumeInstallationEvent(installationID, action, payload)
		return
	case "installation_repositories":
		added := repoNamesOf(payload, "repositories_added")
		removed := repoNamesOf(payload, "repositories_removed")
		_ = s.store.AddGitHubInstallRepos(installationID, added)
		_ = s.store.RemoveGitHubInstallRepos(installationID, removed)
		return
	case "issue_comment":
		if pick(payload, "issue.pull_request.url") == "" {
			return // plain issue comments are not ours
		}
	case "pull_request_review_comment", "pull_request_review":
	case "pull_request":
		if action != "closed" && action != "reopened" {
			return
		}
	default:
		return
	}
	sender := pick(payload, "sender.login")
	if c.githubAppSlug != "" && strings.EqualFold(sender, c.githubAppSlug+"[bot]") {
		return // our own comments must not come back as instructions
	}
	keys := githubEventKeys{
		Repo:   pick(payload, "repository.full_name"),
		Number: firstNonZero(pickInt(payload, "pull_request.number"), pickInt(payload, "issue.number")),
		Sender: sender,
	}
	d, routed, err := routeGitHub(s.store, keys)
	if err != nil {
		slog.Warn("github webhook route failed", "err", err, "delivery", delivery)
		return
	}
	if !routed {
		slog.Info("github webhook unrouted", "repo", keys.Repo, "event", event, "delivery", delivery)
		return
	}
	headers := map[string][]string{
		"content-type":              {"application/json"},
		"x-operon-origin":           {"webhook"},
		"x-operon-webhook-event":    {event},
		"x-operon-webhook-delivery": {delivery},
		"x-operon-route-reason":     {d.Reason},
		"x-operon-actor":            {d.Actor},
	}
	s.deliverWebhook(d.UserID, d.NodeID, "github:"+delivery, webhookPathGitHub, headers, body)
}

func firstNonZero(vals ...int64) int64 {
	for _, v := range vals {
		if v != 0 {
			return v
		}
	}
	return 0
}

func repoNamesOf(p map[string]any, key string) []string {
	out := []string{}
	list, _ := p[key].([]any)
	for _, it := range list {
		if m, ok := it.(map[string]any); ok {
			if n, _ := m["full_name"].(string); n != "" {
				out = append(out, n)
			}
		}
	}
	return out
}

// consumeInstallationEvent keeps github_installs honest when the App is
// removed or suspended on GitHub. A "created" without a matching state (the
// user installed from GitHub's UI, not from operon) is ignored: nobody owns
// it until they go through Settings.
func (s *Server) consumeInstallationEvent(installationID int64, action string, payload map[string]any) {
	switch action {
	case "deleted", "suspend":
		_ = s.store.RevokeGitHubInstall(installationID)
	case "unsuspend":
		if in, ok, _ := s.store.GetGitHubInstall(installationID); ok {
			_ = s.store.UpsertGitHubInstall(GitHubInstallRow{InstallationID: installationID, InstalledByUserID: in.InstalledByUserID, AccountLogin: in.AccountLogin})
		}
	case "created", "new_permissions_accepted":
		if _, ok, _ := s.store.GetGitHubInstall(installationID); ok {
			_ = s.store.ReplaceGitHubInstallRepos(installationID, repoNamesOf(payload, "repositories"))
		}
	}
}

// onlineNodeIDs is the "any machine of theirs that is up" fallback.
func (s *Server) onlineNodeIDs(userID string) []string {
	out := []string{}
	for _, n := range s.reg.ListNodes(userID) {
		out = append(out, n.NodeID)
	}
	return out
}

// webhookAckTimeout bounds how long a forwarded event may go unanswered before
// it is treated as lost and queued. The node answers before doing any work
// (gateway/surfaces/route.ts replies 200 and continues in the background), so a
// healthy tunnel answers in well under a second.
const webhookAckTimeout = 15 * time.Second

// deliverWebhook pushes the event down the node's tunnel, or queues it when the
// node is not connected here.
func (s *Server) deliverWebhook(userID, nodeID, deliveryID, path string, headers map[string][]string, body []byte) {
	if conn, ok := s.reg.Get(userID, nodeID); ok {
		go s.pushWebhook(conn, userID, nodeID, deliveryID, path, headers, body)
		return
	}
	s.queueWebhook(userID, nodeID, deliveryID, path, headers, body, true)
}

// pushWebhook sends the frame and waits for the node's reply. A frame that goes
// unanswered — the tunnel was already dead, the node never replied, or it
// replied 5xx — is queued instead of being written off as "forwarded", so a
// stalled uplink cannot eat an event (the node dedups by delivery id in case it
// did process it after all). Retries ride the maintenance tick, not a fresh
// notice, so a wedged node is not hammered.
func (s *Server) pushWebhook(conn *AgentConn, userID, nodeID, deliveryID, path string, headers map[string][]string, body []byte) {
	f := webhookFrame(conn, path, headers, body)
	p := conn.startRequest(f)
	defer p.cancel()
	timer := time.NewTimer(webhookAckTimeout)
	defer timer.Stop()
	var why string
	select {
	case ev := <-p.events:
		switch {
		case ev.kind == evHead && ev.frame.Status < 500:
			slog.Info("webhook forwarded", "user", userID, "node", nodeID, "path", path, "delivery", deliveryID, "status", ev.frame.Status)
			return
		case ev.kind == evHead:
			why = "status " + strconv.Itoa(ev.frame.Status)
		case ev.kind == evError && ev.frame != nil:
			why = firstNonEmpty(ev.frame.Message, ev.frame.Code, "res-error")
		default:
			why = "ended without a response"
		}
	case <-timer.C:
		conn.cancelRequest(f.ID, "webhook ack timeout")
		why = "no reply within " + webhookAckTimeout.String()
	case <-p.ctx.Done():
		why = "connection closed"
	}
	slog.Warn("webhook not acknowledged; queued for retry", "user", userID, "node", nodeID, "delivery", deliveryID, "why", why)
	s.queueWebhook(userID, nodeID, deliveryID, path, headers, body, false)
}

// queueWebhook parks the event for the node. notify=true announces it to peer
// instances (the node may be connected elsewhere); a retry after a failed push
// stays quiet and waits for the maintenance tick.
func (s *Server) queueWebhook(userID, nodeID, deliveryID, path string, headers map[string][]string, body []byte, notify bool) {
	now := time.Now()
	err := s.store.EnqueueWebhook(QueuedWebhook{
		ID: deliveryID, UserID: userID, NodeID: nodeID, Path: path, Headers: headers,
		Body: string(body), EnqueuedAt: now.UnixMilli(), ExpiresAt: now.Add(s.integrations.queueTTL).UnixMilli(),
	})
	if err != nil {
		slog.Warn("webhook enqueue failed", "err", err, "delivery", deliveryID)
		return
	}
	if !notify {
		return
	}
	slog.Info("webhook queued (node offline)", "user", userID, "node", nodeID, "delivery", deliveryID)
	// "Offline" here means "not on this instance": the owner may be a peer.
	s.dir.notifyWebhookQueued(context.Background(), userID, nodeID)
}

func webhookFrame(conn *AgentConn, path string, headers map[string][]string, body []byte) *Frame {
	enc := ""
	b := ""
	if len(body) > 0 {
		b, enc = encodeBytes(body)
	}
	return &Frame{
		T:       FrameReq,
		ID:      conn.nextID(),
		Method:  http.MethodPost,
		Path:    path,
		Headers: headers,
		Body:    b,
		Enc:     enc,
	}
}

// drainWebhookQueue sends whatever waited for a node that just came online.
func (s *Server) drainWebhookQueue(userID, nodeID string) {
	if s.integrations == nil {
		return
	}
	conn, ok := s.reg.Get(userID, nodeID)
	if !ok {
		return
	}
	items, err := s.store.TakeQueuedWebhooks(userID, nodeID)
	if err != nil {
		slog.Warn("webhook drain failed", "err", err, "user", userID, "node", nodeID)
		return
	}
	if len(items) == 0 {
		return
	}
	slog.Info("webhook queue drained", "user", userID, "node", nodeID, "count", len(items))
	// One goroutine, in order: a queue is the one place ordering still matters.
	go func() {
		for _, it := range items {
			s.pushWebhook(conn, userID, nodeID, it.ID, it.Path, it.Headers, []byte(it.Body))
		}
	}()
}

// runWebhookMaintenance: periodically drains queues for nodes connected to this
// instance (covers a node that reconnected to another instance while the
// event was queued here) and purges expired rows.
func (s *Server) runWebhookMaintenance(ctx context.Context) {
	if s.integrations == nil {
		return
	}
	// Peers announce what they queued for nodes they do not hold; the tick is the
	// fallback for a missed notice (Redis blip) or a node that moved instances.
	go s.dir.subscribeWebhookQueued(ctx, func(uid, nid string) {
		if _, ok := s.reg.Get(uid, nid); ok {
			s.drainWebhookQueue(uid, nid)
		}
	})
	drain := time.NewTicker(10 * time.Second)
	purge := time.NewTicker(time.Hour)
	defer drain.Stop()
	defer purge.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-drain.C:
			pairs, err := s.store.QueuedNodes()
			if err != nil {
				continue
			}
			for _, p := range pairs {
				if _, ok := s.reg.Get(p[0], p[1]); ok {
					s.drainWebhookQueue(p[0], p[1])
				}
			}
		case <-purge.C:
			_ = s.store.PurgeExpiredWebhooks()
			_ = s.store.PurgeDeliveries(deliveryRetention)
		}
	}
}
