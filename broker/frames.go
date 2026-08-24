package main

import (
	"encoding/base64"
	"unicode/utf8"
)

// Frame is the broker⇄agent wire unit: one JSON object per WebSocket text message,
// discriminated by `t`. See docs/remote-tunnel-protocol.md §10 for the field map.
//
// PoC pragmatism: a single struct carries every frame type's fields with
// `omitempty`, rather than a tagged-union per type. Both sides implement the same
// table, so this stays language-neutral on the wire.
type Frame struct {
	T string `json:"t"`

	// --- lifecycle (hello / welcome / ping / pong) ---
	Protocol      int      `json:"protocol,omitempty"`
	Agent         string   `json:"agent,omitempty"`
	Auth          string   `json:"auth,omitempty"`
	NodeID        string   `json:"nodeId,omitempty"`
	Label         string   `json:"label,omitempty"`
	Resume        string   `json:"resume,omitempty"`
	Caps          []string `json:"caps,omitempty"`
	ConnID        string   `json:"connId,omitempty"`
	SessionID     string   `json:"sessionId,omitempty"`
	UserID        string   `json:"userId,omitempty"`
	HeartbeatMs   int      `json:"heartbeatMs,omitempty"`
	MaxInlineBody int      `json:"maxInlineBody,omitempty"`
	TS            int64    `json:"ts,omitempty"`

	// --- request / response (req / res / res-head / res-chunk / res-end) ---
	ID      string              `json:"id,omitempty"`
	Method  string              `json:"method,omitempty"`
	Path    string              `json:"path,omitempty"`
	Query   string              `json:"query,omitempty"`
	Headers map[string][]string `json:"headers,omitempty"`
	Body    string              `json:"body,omitempty"`
	Data    string              `json:"data,omitempty"`
	Enc     string              `json:"enc,omitempty"`
	Status  int                 `json:"status,omitempty"`

	// --- errors / close ---
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	Reason  string `json:"reason,omitempty"`

	// --- raw WebSocket tunnel (ws-open / ws-ack / ws-msg / ws-close), see §2.7 ---
	// OK is a pointer so ws-ack can carry an explicit false. WSCode is the numeric
	// WS close status (1000, …) — distinct from the string Code used elsewhere.
	OK     *bool `json:"ok,omitempty"`
	WSCode int   `json:"wsCode,omitempty"`
}

// Frame type discriminators.
const (
	FrameHello    = "hello"
	FrameWelcome  = "welcome"
	FramePing     = "ping"
	FramePong     = "pong"
	FrameReq      = "req"
	FrameRes      = "res"
	FrameResHead  = "res-head"
	FrameResChunk = "res-chunk"
	FrameResEnd   = "res-end"
	FrameCancel   = "cancel"
	FrameResError = "res-error"
	FrameClose    = "close"

	// Raw WebSocket tunnel (Phase 4): a browser WS becomes a logical stream sharing
	// the request `id` space. See protocol §2.7.
	FrameWSOpen  = "ws-open"
	FrameWSAck   = "ws-ack"
	FrameWSMsg   = "ws-msg"
	FrameWSClose = "ws-close"
)

// encodeBytes serializes a byte payload for the wire: UTF-8 text passes through
// (enc omitted), anything else is base64 (enc="base64").
func encodeBytes(b []byte) (data string, enc string) {
	if utf8.Valid(b) {
		return string(b), ""
	}
	return base64.StdEncoding.EncodeToString(b), "base64"
}

// decodeData reverses encodeBytes for an inbound chunk/body.
func decodeData(data, enc string) []byte {
	if enc == "base64" {
		if b, err := base64.StdEncoding.DecodeString(data); err == nil {
			return b
		}
		return nil
	}
	return []byte(data)
}
