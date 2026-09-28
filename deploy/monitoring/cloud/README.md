# Broker monitoring on Grafana Cloud

This stack runs Grafana Alloy and node-exporter on the broker host. Alloy scrapes
both private broker `/metrics` endpoints plus host metrics, reads broker JSON logs
through the Docker API, and sends them to Grafana Cloud. It does not collect traces. The
broker and public router do not change.

## Configure

1. In Grafana Cloud, get the Metrics remote-write URL and instance ID, and the
   Logs push URL and instance ID. Create a Cloud Access Policy token with only
   `metrics:write` and `logs:write` scopes.
2. On the broker host, copy `.env.example` to `.env`, set those five values, and
   restrict the file to the deployment user (`chmod 600 .env`). Never commit it.
3. Check that `operon-broker_internal` exists, the two broker instances still use
   `172.30.81.11/12:8080`. Production currently uses Docker's `json-file` logging
   driver. The Alloy container has access to the Docker socket so it can discover
   broker containers after restarts; treat this container as host-privileged.
4. Run `docker compose config -q`, then `docker compose up -d`. Alloy has a
   persistent volume for its positions and remote-write queue.

This compose project is separate from the old local VictoriaMetrics/Loki/Grafana
project. If that stack is running, keep it until Cloud ingestion and alerts are verified.

## Verify in Grafana Cloud

- Metrics Explore: `up{job="broker"}` must show `broker1=1` and `broker2=1`;
  `up{job="node"}` must show the host exporter. Check
  `operon_broker_live_conns` and `operon_broker_http_requests_total` too.
- Logs Explore: `{service="operon-broker"}` must return JSON log lines when
  the broker emits them. Use a wider time range if the last six hours are quiet.
  Check `{service="operon-broker",level="ERROR"}` as well.
- Import `./operon-overview.json` as the Operon Broker + Host (Cloud) dashboard. It uses the Cloud Prometheus and
  Loki data sources and the Alloy log labels.
- Recreate the alert rules from `../grafana/provisioning/alerting/rules.yml` in
  Cloud Alerting, pointing them at the Cloud Prometheus data source. Local file
  provisioning is not supported in Grafana Cloud. Configure a contact point and
  notification policy, then send a test notification. Also add an external HTTP
  synthetic check for the public `/ready` route so a host-wide outage is visible
  when Alloy cannot report.

## Alert routing

Put the Broker and host rules in a dedicated alert folder. Add a synthetic check
that probes the public `/ready` endpoint from at least two regions, with failure
and TLS certificate alerts.

Route that folder, and the synthetic check's alerts, to a dedicated contact point
(for example an IRM integration that publishes to a private chat channel). Keep
the default policy's contact point for unrelated Grafana rules.

Use the contact point's **Test** action to verify delivery end to end, and mark
any test alert group resolved afterward. To roll back, restart the old local
monitoring project; it has its own volumes and is not modified by this
configuration.
