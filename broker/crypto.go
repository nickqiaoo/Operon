package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

// sealer is the at-rest encryption for third-party tokens the broker has to
// keep (the Linear app token: Linear has no "private key mints a short-lived
// token" mechanism the way GitHub Apps do, so the long-lived token itself must
// live somewhere, and that somewhere is this table — never a desktop).
//
// AES-256-GCM with a random nonce per value; the ciphertext is stored as
// base64(nonce || ct). The key comes from INTEGRATION_KEK (32 bytes, hex or
// base64). Losing the key means every workspace has to reinstall; rotating it
// is not supported in this version.
type sealer struct {
	aead cipher.AEAD
}

func newSealer(raw string) (*sealer, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("INTEGRATION_KEK is empty")
	}
	var key []byte
	if b, err := hex.DecodeString(raw); err == nil && len(b) == 32 {
		key = b
	} else if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		key = b
	} else if b, err := base64.RawStdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		key = b
	} else {
		return nil, errors.New("INTEGRATION_KEK must be 32 bytes, hex or base64 encoded")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &sealer{aead: aead}, nil
}

func (s *sealer) seal(plain string) (string, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := s.aead.Seal(nil, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(append(nonce, ct...)), nil
}

func (s *sealer) open(enc string) (string, error) {
	if enc == "" {
		return "", nil
	}
	b, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	n := s.aead.NonceSize()
	if len(b) < n {
		return "", fmt.Errorf("sealed value too short")
	}
	plain, err := s.aead.Open(nil, b[:n], b[n:], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
