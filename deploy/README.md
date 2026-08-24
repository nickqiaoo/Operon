# Multi-instance operon broker (OpenResty front router)

Run several broker instances behind OpenResty. A node's tunnel (SSE downlink +
streaming-POST uplink) is pinned to ONE broker instance — the **owner** — and every
request for that node (web API, chat resume/cancel, terminal WebSocket, and the
node's own uplink) must reach the owner. OpenResty does that routing.

## How routing works

Each owner publishes its routes to Redis (TTL 30s, refreshed every 10s):

```
route:node:<uid>:<nid>  ->  http://<owner-host>:<port>
route:conn:<connId>     ->  http://<owner-host>:<port>
drain:instance:<host:port> -> 1
```

OpenResty (`openresty/lua/route.lua`, via `balancer_by_lua`) reads them and dials the
owner directly — no broker→broker hop. Drain markers are skipped for new round-robin
traffic, while existing owner routes still go to the owner so in-flight requests can
finish.

| Request | Routed by |
|---|---|
| `GET /agent/down` | round-robin (the picked instance becomes the owner) |
| `POST /agent/up?connId=` | `route:conn:<connId>` |
| `/u/<uid>/n/<nid>/…` (web + terminal WS) | `route:node:<uid>:<nid>` |
| `/auth/*`, `/health`, `/ready`, … | round-robin (state is shared: Redis + Postgres) |

WebSocket (terminal) is proxied natively by nginx — no app-level WS forwarding.
A route miss falls back to round-robin; that broker answers `agent_offline`/`404` and
the client retries (covers brief route staleness during failover).

The broker only **publishes** routes; it never reads them or forwards between
instances. With no `REDIS_URL`/`INSTANCE_ADDR` it runs as a single instance unchanged.

## Broker env

| Env | Meaning |
|---|---|
| `REDIS_URL` | enables the shared directory + shared OAuth state |
| `INSTANCE_ADDR` | this instance's peer-reachable URL, published as the owner route |
| `JWT_PRIVATE_KEY_PEM` / `JWT_KEY_PATH` | **all instances must share one signing key** |
| `DATABASE_URL` | Postgres (shared identity store) |
| `ADMIN_TOKEN` | enables protected `/admin/*` lifecycle endpoints |

## Run locally

```bash
docker compose -f deploy/docker-compose.yml up --build
# health via either broker, through the router:
curl -s localhost:8080/health
```

Point a node at `BROKER_URL=http://localhost:8080` and the web app's
`VITE_BROKER_URL` at the same. Watch `route:*` keys populate:

```bash
docker compose -f deploy/docker-compose.yml exec redis redis-cli keys 'route:*'
```

Kill the owning broker (`docker compose ... stop broker1`) and the node should
reconnect through the router to `broker2` within the TTL window (its in-flight turn
dies — node-leg drops are not made resumable, by design).

Gracefully drain a specific broker before stopping it:

```bash
docker compose -f deploy/docker-compose.yml exec broker1 \
  wget -qO- --header='Authorization: Bearer dev-admin' --post-data='' \
  http://127.0.0.1:8080/admin/drain

docker compose -f deploy/docker-compose.yml exec broker1 \
  wget -qO- --header='Authorization: Bearer dev-admin' \
  http://127.0.0.1:8080/admin/status
```

Do not call `/admin/drain` through `localhost:8080` OpenResty when you need a specific
instance; that entry is round-robin for admin paths.

## Production (k8s) notes

- **Skip DNS in the balancer:** set `INSTANCE_ADDR=http://$(POD_IP):8080` via the
  downward API so OpenResty dials a pod IP directly (otherwise `route.lua` resolves
  the hostname via `DNS_RESOLVER`, default Docker's `127.0.0.11`; set it to kube-dns).
- **`BROKER_BACKENDS`** (the round-robin set for `/agent/down` and misses) should be
  the broker pods — from the headless Service, or front `/agent/down` with a normal
  k8s Service instead.
- Make Redis HA (Cluster/Sentinel) and inject the same `JWT_PRIVATE_KEY_PEM` to all
  pods (a Secret).
- For higher availability, have nodes open **redundant** downlinks to more than one
  instance (not implemented here).
