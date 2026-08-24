package main

import (
	"context"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ephemeralKV is a short-lived key→value store with per-key TTL and an atomic
// take (get+delete). It backs the OAuth PKCE state and one-time codes, which must be
// shared across broker instances (login is a 3-hop authorize→callback→token dance
// that can land on different instances). Redis-backed when configured; otherwise an
// in-process map (single-instance, the original behavior).
type ephemeralKV interface {
	put(ctx context.Context, key, value string, ttl time.Duration) error
	take(ctx context.Context, key string) (string, bool, error)
}

func newEphemeralKV(rdb *redis.Client) ephemeralKV {
	if rdb != nil {
		return &redisKV{rdb: rdb}
	}
	return newMemoryKV()
}

// --- in-process (single instance) ---

type memoryKV struct {
	mu sync.Mutex
	m  map[string]memEntry
}

type memEntry struct {
	value string
	exp   time.Time
}

func newMemoryKV() *memoryKV { return &memoryKV{m: make(map[string]memEntry)} }

func (k *memoryKV) put(_ context.Context, key, value string, ttl time.Duration) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.m[key] = memEntry{value: value, exp: time.Now().Add(ttl)}
	// opportunistic gc so expired entries don't accumulate
	now := time.Now()
	for kk, v := range k.m {
		if now.After(v.exp) {
			delete(k.m, kk)
		}
	}
	return nil
}

func (k *memoryKV) take(_ context.Context, key string) (string, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	e, ok := k.m[key]
	if !ok {
		return "", false, nil
	}
	delete(k.m, key)
	if time.Now().After(e.exp) {
		return "", false, nil
	}
	return e.value, true, nil
}

// --- Redis (multi instance) ---

type redisKV struct{ rdb *redis.Client }

func (k *redisKV) put(ctx context.Context, key, value string, ttl time.Duration) error {
	return k.rdb.Set(ctx, key, value, ttl).Err()
}

func (k *redisKV) take(ctx context.Context, key string) (string, bool, error) {
	v, err := k.rdb.GetDel(ctx, key).Result()
	if err == redis.Nil {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return v, true, nil
}
