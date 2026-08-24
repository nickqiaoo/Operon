# @xui/tunnel-agent (PoC)

The on-machine peer of the broker. Dials the cloud broker over one WebSocket and
forwards each tunneled request to the local operon backend, streaming the response
back. The tunnel protocol is documented alongside the broker implementation.

```
broker ──WS frames──► tunnel-agent ──fetch──► 127.0.0.1/api (server/)
```

## Run

```bash
# from the repo root (uses root node_modules: ws, tsx)
BROKER_URL=http://127.0.0.1:8080 SECRET=dev NODE_ID=dev \
  npx tsx tunnel-agent/src/index.ts
```

The node leg is plain HTTP: an SSE downlink (`GET /agent/down`) plus a streaming-POST
uplink (`POST /agent/up`), correlated by a broker-minted `connId`.

| Env | Default | Meaning |
|---|---|---|
| `BROKER_URL` | `http://127.0.0.1:8080` | broker HTTP base (`BROKER_WS` accepted, normalized) |
| `SECRET` | `dev` | node token (Bearer auth on down/up) |
| `NODE_ID` | `dev` | this node's stable id (Phase 2: from the node token) |
| `LABEL` | hostname | human name shown in the web node picker |
| `LOCAL_BASE` | _(from file)_ | override the local backend origin; else read `~/.operon/plugin-server.json` |

## Files

| File | Role |
|---|---|
| `src/index.ts` | entry: config + resolve local base + start |
| `src/localPort.ts` | resolve local backend origin (`LOCAL_BASE` or `~/.operon/plugin-server.json`) |
| `src/connection.ts` | WS client: hello/welcome/ping, dispatch, reconnect backoff |
| `src/forward.ts` | `handleReq`: local fetch → stream res-head/chunk/end; cancel → abort |
| `src/frames.ts` | wire frame types + body decode (mirrors the Go broker) |

## PoC scope

Streaming responses + cancel propagation work end to end. Out of scope (later):
JWT/account login, terminal WS (`ws-*`), streamed request bodies. Embeddable into
the Electron main process later via `startAgent()`; PoC runs headless via tsx.
