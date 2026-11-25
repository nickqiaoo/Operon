package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// localNodeID is the id a machine gives itself before it ever signs in: the
// first 128 bits of SHA-256 over a fixed prefix and its delegation public key,
// in hex. Mirrors localNodeIdFor in shared/delegations.ts.
//
// A machine that worked without an account (paired with others and with phones
// over Tailscale only) keeps that id when it signs in, so nothing it is paired
// with has to pair again. Accepting the id only together with the key it is
// derived from means nobody can claim it without the key: the id names the key.
func localNodeID(publicKey []byte) string {
	sum := sha256.Sum256(append([]byte("operon.node-id.v1\n"), publicKey...))
	return hex.EncodeToString(sum[:16])
}

// derivedNodeIDFor reports whether id is the local id of the base64 delegation
// public key, and the decoded key when it is.
func derivedNodeIDFor(id, publicKeyB64 string) ([]byte, bool) {
	if id == "" || publicKeyB64 == "" {
		return nil, false
	}
	key, err := base64.StdEncoding.DecodeString(publicKeyB64)
	if err != nil || len(key) != 32 {
		return nil, false
	}
	return key, localNodeID(key) == id
}
