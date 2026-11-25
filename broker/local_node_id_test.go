package main

import (
	"encoding/base64"
	"testing"
)

func TestLocalNodeIDMatchesTheMachines(t *testing.T) {
	// Same vector as shared/delegations.test.ts: 32 bytes 0x00..0x1f.
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	id := localNodeID(key)
	if len(id) != 32 {
		t.Fatalf("id %q is not 32 hex", id)
	}
	b64 := base64.StdEncoding.EncodeToString(key)
	if _, ok := derivedNodeIDFor(id, b64); !ok {
		t.Fatal("the id of a key is not accepted with that key")
	}
	other := make([]byte, 32)
	if _, ok := derivedNodeIDFor(id, base64.StdEncoding.EncodeToString(other)); ok {
		t.Fatal("an id accepted with a key it was not derived from")
	}
	if _, ok := derivedNodeIDFor(id, "not base64"); ok {
		t.Fatal("an id accepted with no key")
	}
	t.Logf("vector: %s", id)
}
