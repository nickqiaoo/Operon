package main

import (
	"context"
	"testing"
	"time"
)

// A nil/disabled Directory must be a complete no-op so that, with no REDIS_URL, the
// broker behaves exactly as a single instance (publishes nothing, all-local).
func TestDirectoryDisabledIsNoop(t *testing.T) {
	ctx := context.Background()
	for _, d := range []*Directory{nil, {}, {self: "http://x"}} {
		if d.enabled() {
			t.Fatalf("directory should be disabled: %+v", d)
		}
		// none of these should panic or touch Redis
		d.setNode(ctx, "u", "n", time.Second)
		d.setConn(ctx, "c", time.Second)
		d.delNode(ctx, "u", "n")
		d.delConn(ctx, "c")
		if err := d.setDrain(ctx, time.Second); err != nil {
			t.Fatal(err)
		}
		d.delDrain(ctx)
		if err := d.ping(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDrainRouteKeyNormalizesInstanceAddr(t *testing.T) {
	tests := map[string]string{
		"http://broker1:8080":          "drain:instance:broker1:8080",
		"https://10.0.0.7:8080/":       "drain:instance:10.0.0.7:8080",
		"broker2:8080":                 "drain:instance:broker2:8080",
		"  http://172.30.81.11:8080  ": "drain:instance:172.30.81.11:8080",
	}
	for in, want := range tests {
		if got := drainRouteKey(in); got != want {
			t.Fatalf("drainRouteKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMemoryKVTakeIsAtomicAndExpires(t *testing.T) {
	ctx := context.Background()
	kv := newMemoryKV()
	if err := kv.put(ctx, "k", "v", time.Minute); err != nil {
		t.Fatal(err)
	}
	// take returns the value once...
	v, ok, _ := kv.take(ctx, "k")
	if !ok || v != "v" {
		t.Fatalf("take = %q,%v want v,true", v, ok)
	}
	// ...and never again (one-time semantics for OAuth codes/state).
	if _, ok, _ := kv.take(ctx, "k"); ok {
		t.Fatal("second take should miss")
	}
	// expired entries are gone.
	_ = kv.put(ctx, "e", "v", -time.Second)
	if _, ok, _ := kv.take(ctx, "e"); ok {
		t.Fatal("expired take should miss")
	}
}

func TestNewEphemeralKVDefaultsToMemory(t *testing.T) {
	if _, ok := newEphemeralKV(nil).(*memoryKV); !ok {
		t.Fatal("no redis client should yield the in-process memoryKV")
	}
}
