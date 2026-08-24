# operon monitoring

Lightweight metrics + logs for the broker cluster, sized for the small Tencent host.

- **VictoriaMetrics** — scrapes `operon_broker_*` metrics from broker1/broker2 `/metrics`
  and host metrics from node-exporter. Prometheus-compatible (PromQL). 30-day retention.
- **Loki + Promtail** — Promtail reads the systemd journal (docker log driver is
  `journald`) and ships all container logs to Loki. 7-day retention.
- **Grafana** — single UI, provisioned datasources + an "Operon Broker + Host" dashboard.
  Published on `127.0.0.1:3000`, reached at `https://app.operon.teslawrap.top/monitor/`.

## Deploy

```bash
cd ~/operon-broker/monitoring
cp .env.example .env && $EDITOR .env      # set GRAFANA_PASSWORD
docker compose up -d
```

The stack attaches to the existing `operon-broker_internal` network so it can scrape
the brokers at their static IPs (172.30.81.11/12:8080).

## Broker /metrics

The broker exposes Prometheus metrics on its in-cluster `:8080/metrics` (never through
the public front router). Key series:

| Metric | Meaning |
|---|---|
| `operon_broker_live_conns` | live agent tunnels |
| `operon_broker_pending_requests` | in-flight proxied requests |
| `operon_broker_ws_streams` | active terminal WS streams |
| `operon_broker_draining` | 1 if instance draining |
| `operon_broker_http_requests_total{route,method,code}` | request counter |
| `operon_broker_http_request_duration_seconds` | latency of short endpoints |
| `process_resident_memory_bytes{job="broker"}` | broker RSS |

## Handy LogQL

```logql
{container=~".*broker.*"} | json | level="ERROR"
{container=~".*broker.*"} | json | msg=~".*offline.*"
{container="xui-relay-relay-1"}
```
