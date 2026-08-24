# operon-broker (PoC)

Cloud relay between the web client and on-machine agents. A **transparent reverse
proxy**: one catch-all forwards any `/api/*` request over a per-node tunnel; it never
runs app logic. The tunnel protocol is documented alongside the implementation
in this directory.

```
browser ──HTTPS──► broker ──SSE/NDJSON frames──► agent ──► 127.0.0.1/api
```

## Run

```bash
go mod tidy                                  # first time: fetch deps
go build -o operon-broker .
LISTEN_ADDR=:8080 DATABASE_URL=postgres://operon:dev@127.0.0.1:5433/operon?sslmode=disable ./operon-broker
```

| Env | Default | Meaning |
|---|---|---|
| `LISTEN_ADDR` | `:8080` | HTTP listen address |
| `DATABASE_URL` | local dev DSN | Postgres identity store |
| `PUBLIC_URL` | `http://127.0.0.1:8080` | public base URL for OAuth callbacks |
| `REDIS_URL` / `INSTANCE_ADDR` | unset | enable multi-instance routing directory |
| `ADMIN_TOKEN` | unset | enables protected `/admin/*` lifecycle endpoints |

## Routes

| Method · Path | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /ready` | readiness; 503 while draining or when dependencies fail |
| `GET /admin/status` | lifecycle status (requires `ADMIN_TOKEN`) |
| `POST /admin/drain` | stop accepting new node/proxy work and drain current work |
| `POST /admin/undrain` | return a drained live instance to accepting state |
| `GET /agent/down` | agent SSE downlink (welcome → broker→node frames) |
| `POST /agent/up?connId=` | agent streaming-POST uplink (node→broker frames, NDJSON) |
| `ANY /u/{uid}/n/{nid}/api/{rest...}` | transparent proxy to that node's local backend |

## Files

| File | Role |
|---|---|
| `frames.go` | wire frame struct + body enc/dec |
| `registry.go` | `Map<userId, Map<nodeId, conn>>` |
| `agent_conn.go` | per-agent writer/reader (SSE/NDJSON), request multiplexing, cancel |
| `agent_http.go` | `/agent/down` + `/agent/up` handshake + lifecycle |
| `http_proxy.go` | the catch-all HTTP↔frame bridge |
| `nodes.go` | node listing |
| `main.go` | wiring + CORS |

## PoC scope

Single hardcoded user (`dev`), shared-secret auth, no TLS. Streaming + cancel +
multi-node routing work. Out of scope for now: JWT auth, account and node pairing,
the terminal WebSocket tunnel, request-body streaming, and reconnect replay.
