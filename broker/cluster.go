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

// Node ownership. route:node is what the front router reads, so its value stays the
// bare owner URL; route:owner records WHICH connection that owner holds. A node can
// briefly have connections on two instances: when its network drops, the node
// reconnects — possibly to the other instance — while the old instance still thinks
// its conn is alive (behind Cloudflare a dead downlink keeps accepting writes). If both
// kept refreshing route:node, the route would flip between them every few seconds and
// half the web requests would land on the dead conn and hang. So the NEWEST conn
// claims the node outright, every refresh is conditional on still holding the claim,
// and a conn that finds it has lost the claim drops itself.

func nodeOwnerKey(uid, nid string) string { return "route:owner:" + uid + ":" + nid }

// refreshNodeScript extends both keys only while this conn still owns the node. An
// absent owner key (expired after a Redis outage) is re-claimable, which is what lets
// a live owner recover from a flush without reconnecting.
var refreshNodeScript = redis.NewScript(`
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
return 1
`)

// releaseNodeScript removes the routes only if this conn still owns them; otherwise a
// superseded conn's teardown would delete the route its successor just published and
// the node would read as offline until the next refresh.
var releaseNodeScript = redis.NewScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 1
end
return 0
`)

// claimNode makes connID the node's owner unconditionally: a fresh connection is by
// definition newer than whatever the directory holds.
func (d *Directory) claimNode(ctx context.Context, uid, nid, connID string, ttl time.Duration) error {
	if !d.enabled() {
		return nil
	}
	_, err := d.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.Set(ctx, nodeOwnerKey(uid, nid), connID, ttl)
		p.Set(ctx, nodeRouteKey(uid, nid), d.self, ttl)
		return nil
	})
	return err
}

// refreshNode extends the node routes if connID still owns the node. owned=false
// means a newer connection (on this or another instance) has taken over.
func (d *Directory) refreshNode(ctx context.Context, uid, nid, connID string, ttl time.Duration) (owned bool, err error) {
	if !d.enabled() {
		return true, nil
	}
	n, err := refreshNodeScript.Run(ctx, d.rdb,
		[]string{nodeOwnerKey(uid, nid), nodeRouteKey(uid, nid)},
		connID, d.self, ttl.Milliseconds(),
	).Int()
	if err != nil {
		return true, err
	}
	return n == 1, nil
}

// releaseNode drops the node routes if connID still owns them.
func (d *Directory) releaseNode(ctx context.Context, uid, nid, connID string) {
	if !d.enabled() {
		return
	}
	_ = releaseNodeScript.Run(ctx, d.rdb,
		[]string{nodeOwnerKey(uid, nid), nodeRouteKey(uid, nid)},
		connID,
	).Err()
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

// routeHeartbeatInterval is how often a live conn refreshes its routes (TTL is 3×).
// It also bounds how long a superseded conn on another instance survives. A var so
// tests can shorten it.
var routeHeartbeatInterval = 10 * time.Second

// heartbeatRoutes keeps BOTH owner routes fresh while the connection lives, and
// removes them on teardown. A crashed owner stops refreshing → TTLs expire → the
// routes self-clean and the node (which reconnects elsewhere) re-registers.
//
// The conn route needs the same continuous refresh as the node route now that the
// uplink is discrete POSTs: every one of them is routed by conn→owner, so letting
// that key lapse would strand a live connection's uplink.
//
// Supersede across instances: if a refresh finds a newer conn owns the node, this
// conn is a leftover from before the node reconnected, so onSuperseded drops it.
//
// Partition self-protection: if we can't publish for heartbeatMaxFails in a row (e.g.
// this instance is cut off from Redis), we still hold the node's tunnel but it's
// unreachable via the directory — a zombie owner. So we call onDead() to drop the
// connection, forcing the node to reconnect (and the router to re-route it).
func (d *Directory) heartbeatRoutes(ctx context.Context, uid, nid, connID string, onSuperseded, onDead func()) {
	if !d.enabled() {
		return
	}
	const heartbeatMaxFails = 3
	ttl := 3 * routeHeartbeatInterval
	fails := 0
	// publish returns false once the conn is finished (superseded or zombie).
	publish := func(first bool) bool {
		var err error
		owned := true
		if first {
			err = d.claimNode(ctx, uid, nid, connID, ttl)
		} else {
			owned, err = d.refreshNode(ctx, uid, nid, connID, ttl)
		}
		if err == nil && owned {
			err = d.setConn(ctx, connID, ttl)
		}
		if err != nil {
			if ctx.Err() != nil {
				return false // torn down mid-refresh; not a directory failure
			}
			fails++
			slog.Warn("broker: directory heartbeat failed", "node", nid, "fails", fails, "err", err)
			if fails >= heartbeatMaxFails {
				slog.Error("broker: dropping node — directory unreachable (zombie-owner guard)", "node", nid)
				onDead()
				return false
			}
			return true
		}
		fails = 0
		if !owned {
			slog.Warn("broker: superseded by a newer connection, dropping conn", "node", nid, "conn", connID)
			onSuperseded()
			return false
		}
		return true
	}
	cleanup := func() {
		// ctx is done → fresh ctx for cleanup
		bg := context.Background()
		d.releaseNode(bg, uid, nid, connID)
		d.delConn(bg, connID)
	}
	if !publish(true) {
		cleanup()
		return
	}
	t := time.NewTicker(routeHeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if !publish(false) {
				cleanup()
				return
			}
		case <-ctx.Done():
			cleanup()
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

// webhookQueuedChannel carries "uid|nid" notices: a webhook was queued for a node
// that is not connected to the publishing instance. The owner instance drains
// it right away instead of on the next maintenance tick — Linear gives an agent
// ten seconds to acknowledge a session, and the tick alone could eat all of it.
const webhookQueuedChannel = "webhook:queued"

func (d *Directory) notifyWebhookQueued(ctx context.Context, uid, nid string) {
	if !d.enabled() {
		return
	}
	if err := d.rdb.Publish(ctx, webhookQueuedChannel, uid+"|"+nid).Err(); err != nil {
		slog.Warn("broker: webhook queued notify failed", "err", err, "node", nid)
	}
}

// subscribeWebhookQueued calls fn for every notice until ctx ends. The go-redis
// subscription reconnects on its own; a missed notice is covered by the tick.
func (d *Directory) subscribeWebhookQueued(ctx context.Context, fn func(uid, nid string)) {
	if !d.enabled() {
		return
	}
	sub := d.rdb.Subscribe(ctx, webhookQueuedChannel)
	defer sub.Close()
	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			if uid, nid, found := strings.Cut(m.Payload, "|"); found {
				fn(uid, nid)
			}
		}
	}
}
