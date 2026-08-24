package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Store is the broker's persistence for identity: users (GitHub/Google federated)
// and their nodes. Postgres via pgx's database/sql driver. No foreign keys (project
// convention). A networked DB (vs a local file) is what lets the broker scale to
// multiple instances.
type Store struct {
	db *sql.DB
}

type NodeRow struct {
	ID        string
	UserID    string
	Label     string
	CreatedAt int64
	LastSeen  int64
	RevokedAt int64 // 0 = active
}

type RefreshSessionRotation struct {
	UserID      string
	Token       string
	OK          bool
	ClearCookie bool
}

const refreshReuseGrace = 30 * time.Second

// OpenStore connects to Postgres (dsn = DATABASE_URL, e.g.
// postgres://user:pass@host:5432/db?sslmode=disable) and applies migrations.
func OpenStore(dsn string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("db ping: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *Store) migrate() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock(645065813772582023)`); err != nil {
		return err
	}
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id           TEXT PRIMARY KEY,
			provider     TEXT NOT NULL,
			provider_sub TEXT NOT NULL,
			email        TEXT,
			created_at   BIGINT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_sub)`,
		`CREATE TABLE IF NOT EXISTS nodes (
			id         TEXT PRIMARY KEY,
			user_id    TEXT NOT NULL,
			label      TEXT,
			created_at BIGINT NOT NULL,
			last_seen  BIGINT,
			revoked_at BIGINT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id)`,
		`CREATE TABLE IF NOT EXISTS refresh_sessions (
				id         TEXT PRIMARY KEY,
				user_id    TEXT NOT NULL,
				token_hash TEXT NOT NULL,
				created_at BIGINT NOT NULL,
				last_used  BIGINT NOT NULL,
				expires_at BIGINT NOT NULL,
				revoked_at BIGINT
			)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_sessions_hash ON refresh_sessions(token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions(user_id)`,
		// APNs device tokens for the iOS app. Keyed by the token itself: Apple
		// reissues it on reinstall/restore, and the same phone must not
		// accumulate rows.
		`CREATE TABLE IF NOT EXISTS push_devices (
			token      TEXT PRIMARY KEY,
			user_id    TEXT NOT NULL,
			platform   TEXT NOT NULL,
			created_at BIGINT NOT NULL,
			last_seen  BIGINT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id)`,
	}
	for _, q := range stmts {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newRefreshToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func refreshTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// UpsertUser returns the stable userId for a federated identity, creating it on
// first login. Atomic via ON CONFLICT on the (provider, provider_sub) unique index.
//
// An identity IS an account here: signing in with GitHub and signing in with
// Apple deliberately produce two separate accounts, and no attempt is made to
// recognise them as the same person.
//
// That was a considered choice, not an omission. The obvious alternative — link
// them when the verified email matches — was implemented and then removed:
//
//   - It cannot work anyway. Apple's "Hide My Email" mints a per-app relay
//     address that matches nothing, so those users get a second account
//     regardless. A consistency guarantee that holds half the time is not one.
//   - What it buys is small. The broker stores no user content; conversations,
//     workspaces and tasks all live on the user's own machine. Landing in the
//     wrong account costs one re-pairing, not data.
//   - What it costs is not. It makes "same email address" sufficient to inherit
//     someone else's account — and with it, their machines.
//
// Guideline 4.8 requires *offering* Sign in with Apple alongside another social
// login. It says nothing about unifying the accounts behind them.
//
// The user-facing half of this belongs in the UI: an account with no paired
// machines should say so and name the provider you are signed in with, rather
// than presenting an empty list. Should an explicit link ever be wanted, the
// correct shape is user-initiated — prove both identities by signing in to each
// — not an implicit match on a string a third party handed us.
func (s *Store) UpsertUser(provider, sub string) (string, error) {
	var id string
	err := s.db.QueryRow(
		`INSERT INTO users (id, provider, provider_sub, created_at)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (provider, provider_sub) DO UPDATE SET provider = EXCLUDED.provider
		 RETURNING id`,
		newID(), provider, sub, time.Now().UnixMilli(),
	).Scan(&id)
	return id, err
}

// DeleteAccount erases the user and everything attached to it: refresh
// sessions, push devices, and nodes. Required by App Store Guideline 5.1.1(v) — an
// app that creates an account must let the user delete it from inside the app,
// and "delete" has to mean the data is gone, not flagged.
//
// Live tunnels are NOT closed here; the caller does that, since it owns the
// connection registry.
func (s *Store) DeleteAccount(userID string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, q := range []string{
		`DELETE FROM refresh_sessions WHERE user_id = $1`,
		`DELETE FROM push_devices WHERE user_id = $1`,
		`DELETE FROM nodes WHERE user_id = $1`,
		`DELETE FROM users WHERE id = $1`,
	} {
		if _, err := tx.Exec(q, userID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UpsertPushDevice registers (or refreshes) an APNs device token for a user.
//
// The token is the primary key, and it deliberately re-homes to whichever user
// registered it last: one phone signing out and another account signing in must
// not leave the previous owner's notifications going to that device.
func (s *Store) UpsertPushDevice(userID, token, platform string) error {
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(
		`INSERT INTO push_devices (token, user_id, platform, created_at, last_seen)
		 VALUES ($1, $2, $3, $4, $4)
		 ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen = EXCLUDED.last_seen`,
		token, userID, platform, now,
	)
	return err
}

// PushDevice is one registered phone. Platform decides which push service the
// token belongs to — they are not interchangeable.
type PushDevice struct {
	Token    string
	Platform string
}

func (s *Store) ListPushDevices(userID string) ([]PushDevice, error) {
	rows, err := s.db.Query(`SELECT token, platform FROM push_devices WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PushDevice{}
	for rows.Next() {
		var device PushDevice
		if err := rows.Scan(&device.Token, &device.Platform); err != nil {
			return nil, err
		}
		out = append(out, device)
	}
	return out, rows.Err()
}

// DeletePushDevice drops a token, on sign-out or when APNs reports it dead.
func (s *Store) DeletePushDevice(token string) error {
	_, err := s.db.Exec(`DELETE FROM push_devices WHERE token = $1`, token)
	return err
}

// ListNodeIDs returns every node id for a user, so the caller can tear down
// live tunnels before the rows disappear.
func (s *Store) ListNodeIDs(userID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT id FROM nodes WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) CreateRefreshSession(userID string, ttl time.Duration) (string, error) {
	token := newRefreshToken()
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(
		`INSERT INTO refresh_sessions (id, user_id, token_hash, created_at, last_used, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		newID(), userID, refreshTokenHash(token), now, now, time.Now().Add(ttl).UnixMilli(),
	)
	return token, err
}

func (s *Store) RotateRefreshSession(token string, ttl time.Duration) (RefreshSessionRotation, error) {
	now := time.Now()
	nowMs := now.UnixMilli()

	tx, err := s.db.Begin()
	if err != nil {
		return RefreshSessionRotation{}, err
	}
	defer tx.Rollback()

	var id, userID string
	var expiresAt int64
	var revokedAt sql.NullInt64
	err = tx.QueryRow(
		`SELECT id, user_id, expires_at, revoked_at
		 FROM refresh_sessions
		 WHERE token_hash = $1
		 FOR UPDATE`,
		refreshTokenHash(token),
	).Scan(&id, &userID, &expiresAt, &revokedAt)
	if err == sql.ErrNoRows {
		return RefreshSessionRotation{ClearCookie: true}, nil
	}
	if err != nil {
		return RefreshSessionRotation{}, err
	}

	if revokedAt.Valid {
		clearCookie := true
		if nowMs-revokedAt.Int64 <= refreshReuseGrace.Milliseconds() {
			// Likely a parallel browser tab using the pre-rotation cookie. Reject it, but
			// do not clear the newer cookie that another response may already have set.
			clearCookie = false
		} else if _, err := tx.Exec(
			`UPDATE refresh_sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`,
			nowMs, userID,
		); err != nil {
			return RefreshSessionRotation{}, err
		}
		if err := tx.Commit(); err != nil {
			return RefreshSessionRotation{}, err
		}
		return RefreshSessionRotation{ClearCookie: clearCookie}, nil
	}

	if expiresAt <= nowMs {
		if _, err := tx.Exec(
			`UPDATE refresh_sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
			nowMs, id,
		); err != nil {
			return RefreshSessionRotation{}, err
		}
		if err := tx.Commit(); err != nil {
			return RefreshSessionRotation{}, err
		}
		return RefreshSessionRotation{ClearCookie: true}, nil
	}

	nextToken := newRefreshToken()
	if _, err := tx.Exec(
		`UPDATE refresh_sessions SET last_used = $1, revoked_at = $1 WHERE id = $2`,
		nowMs, id,
	); err != nil {
		return RefreshSessionRotation{}, err
	}
	if _, err := tx.Exec(
		`INSERT INTO refresh_sessions (id, user_id, token_hash, created_at, last_used, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		newID(), userID, refreshTokenHash(nextToken), nowMs, nowMs, now.Add(ttl).UnixMilli(),
	); err != nil {
		return RefreshSessionRotation{}, err
	}
	if err := tx.Commit(); err != nil {
		return RefreshSessionRotation{}, err
	}
	return RefreshSessionRotation{UserID: userID, Token: nextToken, OK: true}, nil
}

func (s *Store) RevokeRefreshSession(token string) error {
	_, err := s.db.Exec(
		`UPDATE refresh_sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL`,
		time.Now().UnixMilli(), refreshTokenHash(token),
	)
	return err
}

// CreateNode registers a node for a user and returns its new id.
func (s *Store) CreateNode(userID, label string) (string, error) {
	id := newID()
	_, err := s.db.Exec(
		`INSERT INTO nodes (id, user_id, label, created_at) VALUES ($1, $2, $3, $4)`,
		id, userID, label, time.Now().UnixMilli(),
	)
	return id, err
}

// GetNode looks up a node by id.
func (s *Store) GetNode(nodeID string) (NodeRow, bool, error) {
	var n NodeRow
	var label sql.NullString
	var lastSeen, revoked sql.NullInt64
	err := s.db.QueryRow(
		`SELECT id, user_id, label, created_at, last_seen, revoked_at FROM nodes WHERE id = $1`, nodeID,
	).Scan(&n.ID, &n.UserID, &label, &n.CreatedAt, &lastSeen, &revoked)
	if err == sql.ErrNoRows {
		return NodeRow{}, false, nil
	}
	if err != nil {
		return NodeRow{}, false, err
	}
	n.Label = label.String
	n.LastSeen = lastSeen.Int64
	n.RevokedAt = revoked.Int64
	return n, true, nil
}

// ListNodes returns a user's nodes (revoked included, flagged).
func (s *Store) ListNodes(userID string) ([]NodeRow, error) {
	rows, err := s.db.Query(
		`SELECT id, user_id, label, created_at, last_seen, revoked_at FROM nodes WHERE user_id = $1 ORDER BY created_at`, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NodeRow{}
	for rows.Next() {
		var n NodeRow
		var label sql.NullString
		var lastSeen, revoked sql.NullInt64
		if err := rows.Scan(&n.ID, &n.UserID, &label, &n.CreatedAt, &lastSeen, &revoked); err != nil {
			return nil, err
		}
		n.Label = label.String
		n.LastSeen = lastSeen.Int64
		n.RevokedAt = revoked.Int64
		out = append(out, n)
	}
	return out, rows.Err()
}

// RevokeNode marks a node revoked, but only if it belongs to userID.
func (s *Store) RevokeNode(userID, nodeID string) error {
	res, err := s.db.Exec(
		`UPDATE nodes SET revoked_at = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL`,
		time.Now().UnixMilli(), nodeID, userID,
	)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("node not found or not owned")
	}
	return nil
}

// TouchNode updates last_seen (best-effort).
func (s *Store) TouchNode(nodeID string) {
	_, _ = s.db.Exec(`UPDATE nodes SET last_seen = $1 WHERE id = $2`, time.Now().UnixMilli(), nodeID)
}

// UpdateNodeLabel renames a node (best-effort; used when a re-login on the same
// machine reuses the node id but changes its label).
func (s *Store) UpdateNodeLabel(nodeID, label string) {
	_, _ = s.db.Exec(`UPDATE nodes SET label = $1 WHERE id = $2`, label, nodeID)
}
