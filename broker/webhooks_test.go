package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"
)

// fakeRoutes is an in-memory routeLookup so the person-then-machine algorithm
// (design.md §5.2) is tested without Postgres.
type fakeRoutes struct {
	routes     map[string]RouteRow // kind|key → row (any user)
	identities map[string]LinearIdentityRow
	byUser     map[string]LinearIdentityRow
	installs   map[string]LinearInstallRow
	ghLogins   map[string]string
	ghInstalls map[int64]GitHubInstallRow
}

func newFakeRoutes() *fakeRoutes {
	return &fakeRoutes{
		routes:     map[string]RouteRow{},
		identities: map[string]LinearIdentityRow{}, byUser: map[string]LinearIdentityRow{},
		installs: map[string]LinearInstallRow{}, ghLogins: map[string]string{}, ghInstalls: map[int64]GitHubInstallRow{},
	}
}

func (f *fakeRoutes) route(user, kind, key, node string) {
	f.routes[kind+"|"+key] = RouteRow{UserID: user, Kind: kind, Key: key, NodeID: node}
}
func (f *fakeRoutes) identity(org, linearUser, user, node string) {
	r := LinearIdentityRow{OrgID: org, LinearUserID: linearUser, UserID: user, DefaultNodeID: node}
	f.identities[org+"|"+linearUser] = r
	f.byUser[org+"|"+user] = r
}
func (f *fakeRoutes) FindRoute(kind, key string) (RouteRow, bool, error) {
	r, ok := f.routes[kind+"|"+key]
	return r, ok, nil
}
func (f *fakeRoutes) GetLinearIdentity(org, lu string) (LinearIdentityRow, bool, error) {
	r, ok := f.identities[org+"|"+lu]
	return r, ok, nil
}
func (f *fakeRoutes) GetLinearIdentityByUser(org, u string) (LinearIdentityRow, bool, error) {
	r, ok := f.byUser[org+"|"+u]
	return r, ok, nil
}
func (f *fakeRoutes) GetLinearInstall(org string) (LinearInstallRow, bool, error) {
	r, ok := f.installs[org]
	return r, ok, nil
}
func (f *fakeRoutes) UserByGitHubLogin(login string) (string, bool, error) {
	u, ok := f.ghLogins[login]
	return u, ok, nil
}
func (f *fakeRoutes) GetGitHubInstall(id int64) (GitHubInstallRow, bool, error) {
	r, ok := f.ghInstalls[id]
	return r, ok, nil
}

func noNodes(string) []string { return nil }

func TestRouteLinear_CreatorIdentityWins(t *testing.T) {
	db := newFakeRoutes()
	db.installs["org"] = LinearInstallRow{OrgID: "org", InstalledByUserID: "alice"}
	db.identity("org", "lin-bob", "bob", "bob-laptop")
	d, ok, err := routeLinear(db, linearEventKeys{OrgID: "org", SessionID: "s1", IssueID: "i1", ActorID: "lin-bob"}, noNodes)
	if err != nil || !ok {
		t.Fatalf("routed=%v err=%v", ok, err)
	}
	if d.UserID != "bob" || d.NodeID != "bob-laptop" || d.Reason != "creator" || d.Actor != "owner" {
		t.Fatalf("got %+v", d)
	}
}

func TestRouteLinear_StickyIssueBeatsCreator(t *testing.T) {
	db := newFakeRoutes()
	db.identity("org", "lin-bob", "bob", "bob-laptop")
	db.identity("org", "lin-alice", "alice", "alice-laptop")
	// Alice published the issue from her desktop; Bob delegates it on Linear.
	db.route("alice", "linear_issue", "i1", "alice-laptop")
	d, ok, _ := routeLinear(db, linearEventKeys{OrgID: "org", SessionID: "s2", IssueID: "i1", ActorID: "lin-bob"}, noNodes)
	if !ok || d.UserID != "alice" || d.NodeID != "alice-laptop" || d.Reason != "issue" || d.Actor != "other" {
		t.Fatalf("got %+v", d)
	}
}

func TestRouteLinear_StickySessionOverridesOtherPerson(t *testing.T) {
	db := newFakeRoutes()
	db.identity("org", "lin-bob", "bob", "bob-laptop")
	db.identity("org", "lin-alice", "alice", "alice-laptop")
	db.route("bob", "linear_session", "s1", "bob-laptop")
	// Alice replies in Bob's session: it still goes to Bob's machine, and she is
	// flagged as not the owner so the desktop only records it.
	d, ok, _ := routeLinear(db, linearEventKeys{OrgID: "org", SessionID: "s1", ActorID: "lin-alice"}, noNodes)
	if !ok || d.UserID != "bob" || d.NodeID != "bob-laptop" || d.Reason != "session" || d.Actor != "other" {
		t.Fatalf("got %+v", d)
	}
}

func TestRouteLinear_UnlinkedCreatorFallsBackToInstaller(t *testing.T) {
	db := newFakeRoutes()
	db.installs["org"] = LinearInstallRow{OrgID: "org", InstalledByUserID: "alice"}
	db.identity("org", "lin-alice", "alice", "alice-laptop")
	d, ok, _ := routeLinear(db, linearEventKeys{OrgID: "org", SessionID: "s1", ActorID: "lin-carol"}, noNodes)
	if !ok || d.UserID != "alice" || d.NodeID != "alice-laptop" || d.Reason != "installer" || d.Actor != "unknown" {
		t.Fatalf("got %+v", d)
	}
}

func TestRouteLinear_NoInstallIsUnrouted(t *testing.T) {
	db := newFakeRoutes()
	_, ok, err := routeLinear(db, linearEventKeys{OrgID: "org", SessionID: "s1"}, noNodes)
	if ok || err != nil {
		t.Fatalf("expected unrouted, got ok=%v err=%v", ok, err)
	}
}

func TestRouteLinear_OnlineNodeFallback(t *testing.T) {
	db := newFakeRoutes()
	db.installs["org"] = LinearInstallRow{OrgID: "org", InstalledByUserID: "alice"}
	online := func(u string) []string {
		if u == "alice" {
			return []string{"alice-desk"}
		}
		return nil
	}
	d, ok, _ := routeLinear(db, linearEventKeys{OrgID: "org", SessionID: "s1"}, online)
	if !ok || d.NodeID != "alice-desk" {
		t.Fatalf("got %+v", d)
	}
}

func TestRouteGitHub_StickyPROnly(t *testing.T) {
	db := newFakeRoutes()
	db.ghLogins["alice"] = "alice"
	db.ghLogins["bob"] = "bob"
	db.route("bob", "github_pr", "acme/app#12", "bob-laptop")

	// Alice comments on Bob's PR → Bob's machine, actor=other.
	d, ok, _ := routeGitHub(db, githubEventKeys{Repo: "acme/app", Number: 12, Sender: "alice"})
	if !ok || d.UserID != "bob" || d.NodeID != "bob-laptop" || d.Reason != "pr" || d.Actor != "other" {
		t.Fatalf("got %+v", d)
	}
	// Bob himself → owner.
	d, ok, _ = routeGitHub(db, githubEventKeys{Repo: "acme/app", Number: 12, Sender: "bob"})
	if !ok || d.Actor != "owner" {
		t.Fatalf("got %+v", d)
	}
	// A PR operon did not open is nobody's: dropped, never guessed.
	if _, ok, err := routeGitHub(db, githubEventKeys{Repo: "acme/app", Number: 13, Sender: "alice"}); ok || err != nil {
		t.Fatalf("expected unrouted, got ok=%v err=%v", ok, err)
	}
}

func TestVerifyHMACHex(t *testing.T) {
	body := []byte(`{"type":"AgentSessionEvent"}`)
	mac := hmac.New(sha256.New, []byte("secret"))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))
	if !verifyHMACHex("secret", body, sig) {
		t.Fatal("valid signature rejected")
	}
	if verifyHMACHex("secret", body, "deadbeef") || verifyHMACHex("", body, sig) || verifyHMACHex("other", body, sig) {
		t.Fatal("invalid signature accepted")
	}
}

func TestLinearKeysOf(t *testing.T) {
	p := map[string]any{
		"organizationId": "org",
		"action":         "created",
		"agentSession": map[string]any{
			"id":      "sess",
			"creator": map[string]any{"id": "lin-bob"},
			"issue":   map[string]any{"id": "iss"},
		},
	}
	k, ok := linearKeysOf("AgentSessionEvent", p)
	if !ok || k.SessionID != "sess" || k.IssueID != "iss" || k.ActorID != "lin-bob" {
		t.Fatalf("got %+v ok=%v", k, ok)
	}
	if _, ok := linearKeysOf("Reaction", p); ok {
		t.Fatal("unknown event should not route")
	}
	c := map[string]any{"organizationId": "org", "data": map[string]any{"id": "c1", "issueId": "iss", "userId": "lin-bob"}}
	ck, ok := linearKeysOf("Comment", c)
	if !ok || ck.IssueID != "iss" || ck.ActorID != "lin-bob" {
		t.Fatalf("comment keys: %+v ok=%v", ck, ok)
	}
}

func TestSanitizeStripsBrokerOnlyHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("X-Operon-Origin", "webhook")
	h.Set("X-Operon-Actor", "owner")
	h.Set("X-Operon-Token", "keep-me")
	h.Set("Content-Type", "application/json")
	out := sanitizeReqHeaders(h)
	if _, ok := out["x-operon-origin"]; ok {
		t.Fatal("x-operon-origin must be stripped from client traffic")
	}
	if _, ok := out["x-operon-actor"]; ok {
		t.Fatal("x-operon-actor must be stripped from client traffic")
	}
	if out["x-operon-token"][0] != "keep-me" || out["content-type"][0] != "application/json" {
		t.Fatalf("unrelated headers must survive: %v", out)
	}
}

func TestIsAllowedIntegrationRedirectURI(t *testing.T) {
	if !isAllowedIntegrationRedirectURI("http://127.0.0.1:53421/integrations/callback") {
		t.Fatal("loopback callback should be allowed")
	}
	if isAllowedIntegrationRedirectURI("http://127.0.0.1:53421/auth/callback") {
		t.Fatal("login callback path must not pass the integrations check")
	}
	if isAllowedIntegrationRedirectURI("https://evil.example/integrations/callback") {
		t.Fatal("unknown origin must be rejected")
	}
}

func TestSealerRoundTrip(t *testing.T) {
	s, err := newSealer("0000000000000000000000000000000000000000000000000000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	enc, err := s.seal("lin_oauth_abc")
	if err != nil {
		t.Fatal(err)
	}
	if enc == "lin_oauth_abc" {
		t.Fatal("not encrypted")
	}
	plain, err := s.open(enc)
	if err != nil || plain != "lin_oauth_abc" {
		t.Fatalf("round trip: %q %v", plain, err)
	}
	if _, err := newSealer("short"); err == nil {
		t.Fatal("bad key accepted")
	}
}
