package main

// Prometheus instrumentation for the broker. Kept to a single file plus four lines
// wired in main.go so the change is easy to review and low-risk: it adds a /metrics
// endpoint and a request-counting middleware, and reads the already-existing status
// snapshot (live conns / pending requests / ws streams) at scrape time — no extra
// state kept on the hot path. Scrape target is the in-cluster :8080 (do NOT expose
// /metrics through the public front router).

import (
	"bufio"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	httpRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "operon_broker_http_requests_total",
		Help: "HTTP requests by normalized route, method and status code.",
	}, []string{"route", "method", "code"})

	// Latency is recorded ONLY for short (non-streaming) routes. The tunnel proxy and
	// terminal WS are long-lived (a chat turn can stream for minutes); observing their
	// total duration would wreck the histogram, so they are counted but not timed.
	httpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "operon_broker_http_request_duration_seconds",
		Help:    "Latency of short (non-streaming) endpoints.",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5},
	}, []string{"route", "code"})
)

// registerMetrics builds a private registry (no global state) with the broker's own
// metrics plus Go runtime + process collectors — the latter give
// process_resident_memory_bytes / go_goroutines, handy for watching the broker's own
// footprint on a small host.
func registerMetrics(s *Server) *prometheus.Registry {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		httpRequests,
		httpDuration,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		&statsCollector{s: s},
	)
	return reg
}

func metricsHandler(reg *prometheus.Registry) http.Handler {
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
}

// statsCollector turns the existing BrokerStatus snapshot into gauges at scrape time.
type statsCollector struct{ s *Server }

var (
	descLiveConns  = prometheus.NewDesc("operon_broker_live_conns", "Live agent tunnels.", nil, nil)
	descPending    = prometheus.NewDesc("operon_broker_pending_requests", "In-flight proxied requests.", nil, nil)
	descWSStreams  = prometheus.NewDesc("operon_broker_ws_streams", "Active terminal WebSocket streams.", nil, nil)
	descOpenConns  = prometheus.NewDesc("operon_broker_open_conns", "Tunnels with an open downlink.", nil, nil)
	descDraining   = prometheus.NewDesc("operon_broker_draining", "1 if this instance is draining, else 0.", nil, nil)
)

func (c *statsCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- descLiveConns
	ch <- descPending
	ch <- descWSStreams
	ch <- descOpenConns
	ch <- descDraining
}

func (c *statsCollector) Collect(ch chan<- prometheus.Metric) {
	st := c.s.statusSnapshot()
	g := func(d *prometheus.Desc, v float64) {
		ch <- prometheus.MustNewConstMetric(d, prometheus.GaugeValue, v)
	}
	g(descLiveConns, float64(st.LiveConns))
	g(descPending, float64(st.PendingRequests))
	g(descWSStreams, float64(st.WSStreams))
	g(descOpenConns, float64(st.OpenConns))
	if st.Ready {
		g(descDraining, 0)
	} else {
		g(descDraining, 1)
	}
}

// statusRecorder captures the response status for the middleware. It forwards
// Flush / Hijack / Unwrap so it never breaks the SSE keepalive or the terminal
// WebSocket upgrade — the two things in this proxy that reach past plain Write.
type statusRecorder struct {
	http.ResponseWriter
	code    int
	written bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.written {
		r.code = code
		r.written = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.written {
		r.code = http.StatusOK
		r.written = true
	}
	return r.ResponseWriter.Write(b)
}

func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := r.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// Unwrap lets http.ResponseController (used by coder/websocket) reach the underlying
// writer for Hijack/Flush regardless of this wrapper.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// routeLabel collapses the catch-all proxy path (which carries high-cardinality
// uid/nid/rest) into a fixed, low-cardinality label so the metric series stay bounded.
func routeLabel(p string) string {
	switch {
	case strings.HasPrefix(p, "/u/"):
		return "proxy"
	case strings.HasPrefix(p, "/auth/"):
		return "auth"
	case strings.HasPrefix(p, "/agent/"):
		return "agent_tunnel"
	case strings.HasPrefix(p, "/admin/"):
		return "admin"
	case p == "/health" || p == "/ready":
		return "probe"
	case p == "/metrics":
		return "metrics"
	default:
		return "other"
	}
}

func withMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := routeLabel(r.URL.Path)
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(rec, r)
		code := strconv.Itoa(rec.code)
		httpRequests.WithLabelValues(route, r.Method, code).Inc()
		// Long-lived streams (proxy / terminal WS) are counted but not timed.
		if route != "proxy" && route != "agent_tunnel" && route != "metrics" {
			httpDuration.WithLabelValues(route, code).Observe(time.Since(start).Seconds())
		}
	})
}
