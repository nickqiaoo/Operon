package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// twoInstances returns two Directories sharing one Redis, as broker1/broker2 do.
func twoInstances(t *testing.T) (*miniredis.Miniredis, *Directory, *Directory) {
	t.Helper()
	mr := miniredis.RunT(t)
	mk := func(self string) *Directory {
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		t.Cleanup(func() { _ = rdb.Close() })
		return &Directory{rdb: rdb, self: self}
	}
	return mr, mk("http://broker1:8080"), mk("http://broker2:8080")
}

func routeOf(t *testing.T, mr *miniredis.Miniredis) string {
	t.Helper()
	if !mr.Exists(nodeRouteKey("u", "n")) {
		return ""
	}
	v, err := mr.Get(nodeRouteKey("u", "n"))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// The node reconnected to broker2 while broker1 still holds its old (dead) conn. The
// old conn must stop refreshing the route instead of fighting broker2 for it.
func TestRefreshNodeLosesToNewerClaimOnOtherInstance(t *testing.T) {
	ctx := context.Background()
	mr, b1, b2 := twoInstances(t)

	if err := b1.claimNode(ctx, "u", "n", "old", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := b2.claimNode(ctx, "u", "n", "new", time.Minute); err != nil {
		t.Fatal(err)
	}
	owned, err := b1.refreshNode(ctx, "u", "n", "old", time.Minute)
	if err != nil || owned {
		t.Fatalf("old conn refresh = %v,%v want false,nil", owned, err)
	}
	if got := routeOf(t, mr); got != "http://broker2:8080" {
		t.Fatalf("route = %q, want broker2 (old owner must not overwrite)", got)
	}
	if owned, err := b2.refreshNode(ctx, "u", "n", "new", time.Minute); err != nil || !owned {
		t.Fatalf("new conn refresh = %v,%v want true,nil", owned, err)
	}
}

// Tearing down the superseded conn must not delete its successor's route — that
// would show the node offline until the next refresh.
func TestReleaseNodeKeepsSuccessorRoute(t *testing.T) {
	ctx := context.Background()
	mr, b1, b2 := twoInstances(t)

	_ = b1.claimNode(ctx, "u", "n", "old", time.Minute)
	_ = b2.claimNode(ctx, "u", "n", "new", time.Minute)
	b1.releaseNode(ctx, "u", "n", "old")
	if got := routeOf(t, mr); got != "http://broker2:8080" {
		t.Fatalf("route = %q after old release, want broker2", got)
	}
	b2.releaseNode(ctx, "u", "n", "new")
	if got := routeOf(t, mr); got != "" {
		t.Fatalf("route = %q after owner release, want gone", got)
	}
	if mr.Exists(nodeOwnerKey("u", "n")) {
		t.Fatal("owner key should be gone after owner release")
	}
}

// An expired owner key (e.g. Redis was flushed) is re-claimed by the live conn's
// next refresh rather than leaving the node unroutable.
func TestRefreshNodeReclaimsExpiredOwner(t *testing.T) {
	ctx := context.Background()
	mr, b1, _ := twoInstances(t)

	_ = b1.claimNode(ctx, "u", "n", "c1", time.Second)
	mr.FastForward(2 * time.Second)
	if routeOf(t, mr) != "" {
		t.Fatal("route should have expired")
	}
	if owned, err := b1.refreshNode(ctx, "u", "n", "c1", time.Minute); err != nil || !owned {
		t.Fatalf("refresh after expiry = %v,%v want true,nil", owned, err)
	}
	if got := routeOf(t, mr); got != "http://broker1:8080" {
		t.Fatalf("route = %q, want broker1", got)
	}
}

// End to end through heartbeatRoutes: the old conn's heartbeat notices the newer
// claim within one interval and calls onSuperseded (not onDead).
func TestHeartbeatRoutesSupersedesAcrossInstances(t *testing.T) {
	prev := routeHeartbeatInterval
	routeHeartbeatInterval = 20 * time.Millisecond
	t.Cleanup(func() { routeHeartbeatInterval = prev })

	mr, b1, b2 := twoInstances(t)
	oldCtx, oldCancel := context.WithCancel(context.Background())
	defer oldCancel()
	var superseded, dead atomic.Bool
	done := make(chan struct{})
	go func() {
		b1.heartbeatRoutes(oldCtx, "u", "n", "old",
			func() { superseded.Store(true); oldCancel() },
			func() { dead.Store(true); oldCancel() })
		close(done)
	}()
	waitFor(t, func() bool { return routeOf(t, mr) == "http://broker1:8080" })

	newCtx, newCancel := context.WithCancel(context.Background())
	defer newCancel()
	go b2.heartbeatRoutes(newCtx, "u", "n", "new", func() {}, func() {})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("old conn's heartbeat never noticed it was superseded")
	}
	if !superseded.Load() || dead.Load() {
		t.Fatalf("superseded=%v dead=%v, want true,false", superseded.Load(), dead.Load())
	}
	if mr.Exists(connRouteKey("old")) {
		t.Fatal("superseded conn's uplink route should be removed")
	}
	// Several more intervals: the route must stay on broker2 (no flapping).
	for i := 0; i < 5; i++ {
		time.Sleep(routeHeartbeatInterval)
		if got := routeOf(t, mr); got != "http://broker2:8080" {
			t.Fatalf("route flipped to %q", got)
		}
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
