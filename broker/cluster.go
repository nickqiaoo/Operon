package main

import (
	"context"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// cluster.go is the shared state that lets several broker instances cooperate.
//
// A node's AgentConn is a singleton living on ONE instance (the owner): all traffic
// for that node — web requests, chat resume/cancel, and the node's own uplink — must
// reach that instance. The Directory is the shared routing table that makes this
// possible: each owner publishes node→self and connId→self here, and the front
// router (OpenResty's balancer_by_lua) reads it to route every request straight to
// the owner. Connections and chat buffers stay in the owner's memory; only this
// directory is shared, and the broker itself never reads it (routing is the router's
// job — see deploy/openresty).
//
// Everything is nil/disabled-safe: with no REDIS_URL (and no INSTANCE_ADDR) the
// Directory is disabled and the broker runs exactly as a single instance.

type Directory struct {
	rdb  *redis.Client
	self string // this instance's peer-reachable base URL, e.g. http://10.0.0.3:8080
}

func (d *Directory) enabled() bool { return d != nil && d.rdb != nil && d.self != "" }

func nodeRouteKey(uid, nid string) string { return "route:node:" + uid + ":" + nid }
func connRouteKey(connID string) string   { return "route:conn:" + connID }
func drainRouteKey(addr string) string    { return "drain:instance:" + routeAddr(addr) }

func routeAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return ""
	}
	if u, err := url.Parse(addr); err == nil && u.Host != "" {
		return u.Host
	}
	addr = strings.TrimPrefix(strings.TrimPrefix(addr, "http://"), "https://")
	if i := strings.IndexByte(addr, '/'); i >= 0 {
		addr = addr[:i]
	}
	return addr
}

func (d *Directory) setNode(ctx context.Context, uid, nid string, ttl time.Duration) error {
	if !d.enabled() {
		return nil
	}
	return d.rdb.Set(ctx, nodeRouteKey(uid, nid), d.self, ttl).Err()
}

func (d *Directory) delNode(ctx context.Context, uid, nid string) {
	if !d.enabled() {
		return
	}
	_ = d.rdb.Del(ctx, nodeRouteKey(uid, nid)).Err()
}

// nodeOnline reports whether some instance currently owns this node's tunnel, per
// the shared route directory. /auth/nodes uses it so the answer is consistent no
// matter which instance serves the (round-robined) request — the local Registry
// only knows nodes owned by THIS instance, so without this check the reported
// status flaps online/offline between the owner and non-owner instances.
func (d *Directory) nodeOnline(ctx context.Context, uid, nid string) bool {
	if !d.enabled() {
		return false
	}
	n, err := d.rdb.Exists(ctx, nodeRouteKey(uid, nid)).Result()
	return err == nil && n > 0
}

func (d *Directory) setConn(ctx context.Context, connID string, ttl time.Duration) error {
	if !d.enabled() {
		return nil
	}
	return d.rdb.Set(ctx, connRouteKey(connID), d.self, ttl).Err()
}

func (d *Directory) delConn(ctx context.Context, connID string) {
	if !d.enabled() {
		return
	}
	_ = d.rdb.Del(ctx, connRouteKey(connID)).Err()
}

func (d *Directory) setDrain(ctx context.Context, ttl time.Duration) error {
	if !d.enabled() {
		return nil
	}
	return d.rdb.Set(ctx, drainRouteKey(d.self), "1", ttl).Err()
}

func (d *Directory) delDrain(ctx context.Context) {
	if !d.enabled() {
		return
	}
	_ = d.rdb.Del(ctx, drainRouteKey(d.self)).Err()
}

func (d *Directory) ping(ctx context.Context) error {
	if !d.enabled() {
		return nil
	}
	return d.rdb.Ping(ctx).Err()
}

// heartbeatRoutes keeps BOTH owner routes fresh while the connection lives, and
// removes them on teardown. A crashed owner stops refreshing → TTLs expire → the
// routes self-clean and the node (which reconnects elsewhere) re-registers.
//
// The conn route needs the same continuous refresh as the node route now that the
// uplink is discrete POSTs: every one of them is routed by conn→owner, so letting
// that key lapse would strand a live connection's uplink.
//
// Partition self-protection: if we can't publish for heartbeatMaxFails in a row (e.g.
// this instance is cut off from Redis), we still hold the node's tunnel but it's
// unreachable via the directory — a zombie owner. So we call onDead() to drop the
// connection, forcing the node to reconnect (and the router to re-route it).
func (d *Directory) heartbeatRoutes(ctx context.Context, uid, nid, connID string, onDead func()) {
	if !d.enabled() {
		return
	}
	const heartbeatMaxFails = 3
	fails := 0
	refresh := func() {
		err := d.setNode(ctx, uid, nid, 30*time.Second)
		if err == nil {
			err = d.setConn(ctx, connID, 30*time.Second)
		}
		if err != nil {
			fails++
			slog.Warn("broker: directory heartbeat failed", "node", nid, "fails", fails, "err", err)
			if fails >= heartbeatMaxFails {
				slog.Error("broker: dropping node — directory unreachable (zombie-owner guard)", "node", nid)
				onDead()
			}
			return
		}
		fails = 0
	}
	refresh()
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			refresh()
		case <-ctx.Done():
			// ctx is done → fresh ctx for cleanup
			cleanup := context.Background()
			d.delNode(cleanup, uid, nid)
			d.delConn(cleanup, connID)
			return
		}
	}
}

// openRedis builds a client for REDIS_URL, or returns nil (single-instance) when
// unset/unparsable. A boot-time ping just logs reachability; the client reconnects
// on its own, so a transient Redis blip degrades remote routing rather than crashing.
func openRedis(redisURL string) *redis.Client {
	if redisURL == "" {
		return nil
	}
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		slog.Error("broker: invalid REDIS_URL, running single-instance", "err", err)
		return nil
	}
	rdb := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		slog.Warn("broker: Redis ping failed at boot (will retry in background)", "err", err)
	}
	return rdb
}
