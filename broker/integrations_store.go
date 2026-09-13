package main

import (
	"database/sql"
	"encoding/json"
	"time"
)

// Persistence for the Linear × GitHub integration (docs/linear-github/design.md §5).
// Same conventions as store.go: hand-written SQL, no foreign keys, BIGINT millis.

// --- users.github_login ---

func (s *Store) SetUserGitHubLogin(userID, login string) error {
	_, err := s.db.Exec(`UPDATE users SET github_login = $1 WHERE id = $2`, login, userID)
	return err
}

func (s *Store) UserByGitHubLogin(login string) (string, bool, error) {
	if login == "" {
		return "", false, nil
	}
	var id string
	err := s.db.QueryRow(`SELECT id FROM users WHERE LOWER(github_login) = LOWER($1) LIMIT 1`, login).Scan(&id)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return id, err == nil, err
}

func (s *Store) GitHubLoginOfUser(userID string) (string, error) {
	var login sql.NullString
	err := s.db.QueryRow(`SELECT github_login FROM users WHERE id = $1`, userID).Scan(&login)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return login.String, err
}

// --- linear_installs ---

type LinearInstallRow struct {
	OrgID             string
	InstalledByUserID string
	AppUserID         string
	AppUserName       string
	WorkspaceName     string
	URLKey            string
	AccessTokenEnc    string
	RefreshTokenEnc   string
	ExpiresAt         int64
	CreatedAt         int64
	RevokedAt         int64
}

func (s *Store) UpsertLinearInstall(r LinearInstallRow) error {
	_, err := s.db.Exec(
		`INSERT INTO linear_installs (org_id, installed_by_user_id, app_user_id, app_user_name, workspace_name, url_key,
		                              access_token_enc, refresh_token_enc, expires_at, created_at, revoked_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
		 ON CONFLICT (org_id) DO UPDATE SET
		   installed_by_user_id = EXCLUDED.installed_by_user_id,
		   app_user_id = EXCLUDED.app_user_id,
		   app_user_name = EXCLUDED.app_user_name,
		   workspace_name = EXCLUDED.workspace_name,
		   url_key = EXCLUDED.url_key,
		   access_token_enc = EXCLUDED.access_token_enc,
		   refresh_token_enc = EXCLUDED.refresh_token_enc,
		   expires_at = EXCLUDED.expires_at,
		   revoked_at = NULL`,
		r.OrgID, r.InstalledByUserID, r.AppUserID, r.AppUserName, r.WorkspaceName, r.URLKey,
		r.AccessTokenEnc, r.RefreshTokenEnc, r.ExpiresAt, time.Now().UnixMilli(),
	)
	return err
}

func (s *Store) UpdateLinearInstallToken(orgID, accessEnc, refreshEnc string, expiresAt int64) error {
	_, err := s.db.Exec(
		`UPDATE linear_installs SET access_token_enc = $1, refresh_token_enc = $2, expires_at = $3 WHERE org_id = $4`,
		accessEnc, refreshEnc, expiresAt, orgID,
	)
	return err
}

func (s *Store) RevokeLinearInstall(orgID string) error {
	_, err := s.db.Exec(`UPDATE linear_installs SET revoked_at = $1 WHERE org_id = $2 AND revoked_at IS NULL`, time.Now().UnixMilli(), orgID)
	return err
}

const linearInstallCols = `org_id, installed_by_user_id, app_user_id, app_user_name, workspace_name, url_key,
	access_token_enc, refresh_token_enc, expires_at, created_at, revoked_at`

func scanLinearInstall(sc interface{ Scan(...any) error }) (LinearInstallRow, error) {
	var r LinearInstallRow
	var appName, wsName, urlKey, refresh sql.NullString
	var revoked sql.NullInt64
	err := sc.Scan(&r.OrgID, &r.InstalledByUserID, &r.AppUserID, &appName, &wsName, &urlKey,
		&r.AccessTokenEnc, &refresh, &r.ExpiresAt, &r.CreatedAt, &revoked)
	r.AppUserName = appName.String
	r.WorkspaceName = wsName.String
	r.URLKey = urlKey.String
	r.RefreshTokenEnc = refresh.String
	r.RevokedAt = revoked.Int64
	return r, err
}

func (s *Store) GetLinearInstall(orgID string) (LinearInstallRow, bool, error) {
	row := s.db.QueryRow(`SELECT `+linearInstallCols+` FROM linear_installs WHERE org_id = $1`, orgID)
	r, err := scanLinearInstall(row)
	if err == sql.ErrNoRows {
		return LinearInstallRow{}, false, nil
	}
	return r, err == nil, err
}

// LinearInstallsVisibleTo lists the workspaces a user can see: the ones they
// installed and the ones they linked an identity in.
func (s *Store) LinearInstallsVisibleTo(userID string) ([]LinearInstallRow, error) {
	rows, err := s.db.Query(
		`SELECT `+linearInstallCols+` FROM linear_installs
		 WHERE installed_by_user_id = $1
		    OR org_id IN (SELECT org_id FROM linear_identities WHERE user_id = $1)
		 ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LinearInstallRow{}
	for rows.Next() {
		r, err := scanLinearInstall(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// --- linear_identities ---

type LinearIdentityRow struct {
	OrgID         string
	LinearUserID  string
	UserID        string
	DefaultNodeID string
	DisplayName   string
	CreatedAt     int64
}

func (s *Store) UpsertLinearIdentity(r LinearIdentityRow) error {
	// One operon account is one person per workspace: a re-link from another
	// Linear account replaces the old row rather than adding a second one.
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM linear_identities WHERE org_id = $1 AND user_id = $2 AND linear_user_id <> $3`,
		r.OrgID, r.UserID, r.LinearUserID); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO linear_identities (org_id, linear_user_id, user_id, default_node_id, display_name, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (org_id, linear_user_id) DO UPDATE SET
		   user_id = EXCLUDED.user_id, default_node_id = EXCLUDED.default_node_id, display_name = EXCLUDED.display_name`,
		r.OrgID, r.LinearUserID, r.UserID, r.DefaultNodeID, r.DisplayName, time.Now().UnixMilli(),
	); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteLinearIdentity(orgID, userID string) error {
	_, err := s.db.Exec(`DELETE FROM linear_identities WHERE org_id = $1 AND user_id = $2`, orgID, userID)
	return err
}

func scanLinearIdentity(sc interface{ Scan(...any) error }) (LinearIdentityRow, error) {
	var r LinearIdentityRow
	var name sql.NullString
	err := sc.Scan(&r.OrgID, &r.LinearUserID, &r.UserID, &r.DefaultNodeID, &name, &r.CreatedAt)
	r.DisplayName = name.String
	return r, err
}

const linearIdentityCols = `org_id, linear_user_id, user_id, default_node_id, display_name, created_at`

func (s *Store) GetLinearIdentity(orgID, linearUserID string) (LinearIdentityRow, bool, error) {
	row := s.db.QueryRow(`SELECT `+linearIdentityCols+` FROM linear_identities WHERE org_id = $1 AND linear_user_id = $2`, orgID, linearUserID)
	r, err := scanLinearIdentity(row)
	if err == sql.ErrNoRows {
		return LinearIdentityRow{}, false, nil
	}
	return r, err == nil, err
}

func (s *Store) GetLinearIdentityByUser(orgID, userID string) (LinearIdentityRow, bool, error) {
	row := s.db.QueryRow(`SELECT `+linearIdentityCols+` FROM linear_identities WHERE org_id = $1 AND user_id = $2`, orgID, userID)
	r, err := scanLinearIdentity(row)
	if err == sql.ErrNoRows {
		return LinearIdentityRow{}, false, nil
	}
	return r, err == nil, err
}

// --- github_installs ---

type GitHubInstallRow struct {
	InstallationID    int64
	InstalledByUserID string
	AccountLogin      string
	CreatedAt         int64
	RevokedAt         int64
}

func (s *Store) UpsertGitHubInstall(r GitHubInstallRow) error {
	_, err := s.db.Exec(
		`INSERT INTO github_installs (installation_id, installed_by_user_id, account_login, created_at, revoked_at)
		 VALUES ($1, $2, $3, $4, NULL)
		 ON CONFLICT (installation_id) DO UPDATE SET
		   installed_by_user_id = EXCLUDED.installed_by_user_id, account_login = EXCLUDED.account_login, revoked_at = NULL`,
		r.InstallationID, r.InstalledByUserID, r.AccountLogin, time.Now().UnixMilli(),
	)
	return err
}

func (s *Store) RevokeGitHubInstall(installationID int64) error {
	_, err := s.db.Exec(`UPDATE github_installs SET revoked_at = $1 WHERE installation_id = $2 AND revoked_at IS NULL`, time.Now().UnixMilli(), installationID)
	return err
}

func scanGitHubInstall(sc interface{ Scan(...any) error }) (GitHubInstallRow, error) {
	var r GitHubInstallRow
	var login sql.NullString
	var revoked sql.NullInt64
	err := sc.Scan(&r.InstallationID, &r.InstalledByUserID, &login, &r.CreatedAt, &revoked)
	r.AccountLogin = login.String
	r.RevokedAt = revoked.Int64
	return r, err
}

func (s *Store) GetGitHubInstall(installationID int64) (GitHubInstallRow, bool, error) {
	row := s.db.QueryRow(`SELECT installation_id, installed_by_user_id, account_login, created_at, revoked_at FROM github_installs WHERE installation_id = $1`, installationID)
	r, err := scanGitHubInstall(row)
	if err == sql.ErrNoRows {
		return GitHubInstallRow{}, false, nil
	}
	return r, err == nil, err
}

func (s *Store) ListGitHubInstallsBy(userID string) ([]GitHubInstallRow, error) {
	rows, err := s.db.Query(`SELECT installation_id, installed_by_user_id, account_login, created_at, revoked_at
		FROM github_installs WHERE installed_by_user_id = $1 AND revoked_at IS NULL ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GitHubInstallRow{}
	for rows.Next() {
		r, err := scanGitHubInstall(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) ReplaceGitHubInstallRepos(installationID int64, fullNames []string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM github_install_repos WHERE installation_id = $1`, installationID); err != nil {
		return err
	}
	for _, name := range fullNames {
		if _, err := tx.Exec(`INSERT INTO github_install_repos (installation_id, full_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, installationID, name); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) AddGitHubInstallRepos(installationID int64, fullNames []string) error {
	for _, name := range fullNames {
		if _, err := s.db.Exec(`INSERT INTO github_install_repos (installation_id, full_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, installationID, name); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) RemoveGitHubInstallRepos(installationID int64, fullNames []string) error {
	for _, name := range fullNames {
		if _, err := s.db.Exec(`DELETE FROM github_install_repos WHERE installation_id = $1 AND full_name = $2`, installationID, name); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GitHubInstallRepos(installationID int64) ([]string, error) {
	rows, err := s.db.Query(`SELECT full_name FROM github_install_repos WHERE installation_id = $1 ORDER BY full_name`, installationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// GitHubInstallForRepo finds the live installation that covers owner/name.
func (s *Store) GitHubInstallForRepo(fullName string) (GitHubInstallRow, bool, error) {
	row := s.db.QueryRow(
		`SELECT i.installation_id, i.installed_by_user_id, i.account_login, i.created_at, i.revoked_at
		 FROM github_install_repos r JOIN github_installs i ON i.installation_id = r.installation_id
		 WHERE LOWER(r.full_name) = LOWER($1) AND i.revoked_at IS NULL
		 ORDER BY i.created_at LIMIT 1`, fullName)
	r, err := scanGitHubInstall(row)
	if err == sql.ErrNoRows {
		return GitHubInstallRow{}, false, nil
	}
	return r, err == nil, err
}

// --- integration_routes ---

type RouteRow struct {
	UserID    string
	Kind      string
	Key       string
	NodeID    string
	UpdatedAt int64
}

// UpsertRoute is the desktop's own claim (the issue it published, the PR it
// opened): the row moves with the node that last claimed it.
func (s *Store) UpsertRoute(userID, kind, key, nodeID string) error {
	_, err := s.db.Exec(
		`INSERT INTO integration_routes (user_id, kind, key, node_id, updated_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (user_id, kind, key) DO UPDATE SET node_id = EXCLUDED.node_id, updated_at = EXCLUDED.updated_at`,
		userID, kind, key, nodeID, time.Now().UnixMilli(),
	)
	return err
}

// ClaimRoute writes a sticky row only if none exists for (kind, key) under any
// user — first pickup wins.
func (s *Store) ClaimRoute(userID, kind, key, nodeID string) error {
	var exists int
	err := s.db.QueryRow(`SELECT 1 FROM integration_routes WHERE kind = $1 AND key = $2 LIMIT 1`, kind, key).Scan(&exists)
	if err == nil {
		return nil
	}
	if err != sql.ErrNoRows {
		return err
	}
	_, err = s.db.Exec(
		`INSERT INTO integration_routes (user_id, kind, key, node_id, updated_at) VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (user_id, kind, key) DO NOTHING`,
		userID, kind, key, nodeID, time.Now().UnixMilli())
	return err
}

// FindRoute looks a sticky key up across all users (session / issue / PR ids
// are globally unique on their platform).
func (s *Store) FindRoute(kind, key string) (RouteRow, bool, error) {
	var r RouteRow
	err := s.db.QueryRow(`SELECT user_id, kind, key, node_id, updated_at FROM integration_routes WHERE kind = $1 AND key = $2 ORDER BY updated_at LIMIT 1`, kind, key).
		Scan(&r.UserID, &r.Kind, &r.Key, &r.NodeID, &r.UpdatedAt)
	if err == sql.ErrNoRows {
		return RouteRow{}, false, nil
	}
	return r, err == nil, err
}

// --- webhook_deliveries ---

// MarkDelivery records a delivery id; false means it was already seen.
func (s *Store) MarkDelivery(id string) (bool, error) {
	res, err := s.db.Exec(`INSERT INTO webhook_deliveries (id, received_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, id, time.Now().UnixMilli())
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) PurgeDeliveries(olderThan time.Duration) error {
	_, err := s.db.Exec(`DELETE FROM webhook_deliveries WHERE received_at < $1`, time.Now().Add(-olderThan).UnixMilli())
	return err
}

// --- webhook_queue ---

type QueuedWebhook struct {
	ID         string
	UserID     string
	NodeID     string
	Path       string
	Headers    map[string][]string
	Body       string
	EnqueuedAt int64
	ExpiresAt  int64
}

func (s *Store) EnqueueWebhook(q QueuedWebhook) error {
	hb, _ := json.Marshal(q.Headers)
	_, err := s.db.Exec(
		`INSERT INTO webhook_queue (id, user_id, node_id, path, headers, body, enqueued_at, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
		q.ID, q.UserID, q.NodeID, q.Path, string(hb), q.Body, q.EnqueuedAt, q.ExpiresAt)
	return err
}

// TakeQueuedWebhooks removes and returns everything queued for a node, oldest
// first. Expired rows are dropped, not returned.
func (s *Store) TakeQueuedWebhooks(userID, nodeID string) ([]QueuedWebhook, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := time.Now().UnixMilli()
	rows, err := tx.Query(
		`DELETE FROM webhook_queue WHERE user_id = $1 AND node_id = $2
		 RETURNING id, user_id, node_id, path, headers, body, enqueued_at, expires_at`, userID, nodeID)
	if err != nil {
		return nil, err
	}
	out := []QueuedWebhook{}
	for rows.Next() {
		var q QueuedWebhook
		var hb string
		if err := rows.Scan(&q.ID, &q.UserID, &q.NodeID, &q.Path, &hb, &q.Body, &q.EnqueuedAt, &q.ExpiresAt); err != nil {
			rows.Close()
			return nil, err
		}
		if q.ExpiresAt < now {
			continue
		}
		_ = json.Unmarshal([]byte(hb), &q.Headers)
		out = append(out, q)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// Oldest first (RETURNING has no guaranteed order).
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].EnqueuedAt < out[j-1].EnqueuedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// QueuedNodes lists (user, node) pairs with something waiting — the periodic
// drain loop checks each against the local registry.
func (s *Store) QueuedNodes() ([][2]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT user_id, node_id FROM webhook_queue WHERE expires_at >= $1`, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := [][2]string{}
	for rows.Next() {
		var u, n string
		if err := rows.Scan(&u, &n); err != nil {
			return nil, err
		}
		out = append(out, [2]string{u, n})
	}
	return out, rows.Err()
}

func (s *Store) PurgeExpiredWebhooks() error {
	_, err := s.db.Exec(`DELETE FROM webhook_queue WHERE expires_at < $1`, time.Now().UnixMilli())
	return err
}
