package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestHandleRoot(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handleRoot(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["service"] != "hello-service" {
		t.Errorf("unexpected service name: %s", body["service"])
	}
}

func TestHandleLiveness(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rr := httptest.NewRecorder()
	handleLiveness(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestHandleReadiness(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/ready", nil)
	rr := httptest.NewRecorder()
	handleReadiness(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestHandleRootNotFound(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/unknown", nil)
	rr := httptest.NewRecorder()
	handleRoot(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rr.Code)
	}
}

func TestRouteLabelBoundsCardinality(t *testing.T) {
	for path, want := range map[string]string{
		"/":             "/",
		"/healthz":      "/healthz",
		"/ready":        "/ready",
		"/openapi.json": "/openapi.json",
		"/users/42":     "other",
		"/../etc":       "other",
	} {
		if got := routeLabel(path); got != want {
			t.Errorf("routeLabel(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestHandleOpenAPISpec(t *testing.T) {
	rr := httptest.NewRecorder()
	handleOpenAPISpec(rr, httptest.NewRequest(http.MethodGet, "/openapi.json", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("unexpected Content-Type %q", ct)
	}
	var spec map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&spec); err != nil {
		t.Fatalf("spec is not valid JSON: %v", err)
	}
	paths, _ := spec["paths"].(map[string]any)
	for _, p := range []string{"/", "/healthz", "/ready"} {
		if _, ok := paths[p]; !ok {
			t.Errorf("spec is missing path %s", p)
		}
	}
}

func TestGetEnv(t *testing.T) {
	t.Setenv("HELLO_TEST_VAR", "set")
	if got := getEnv("HELLO_TEST_VAR", "default"); got != "set" {
		t.Errorf("got %q, want the env value", got)
	}
	if got := getEnv("HELLO_TEST_VAR_UNSET", "default"); got != "default" {
		t.Errorf("got %q, want the default", got)
	}
}

// Drives the real handler chain from newServer: routing, the metrics
// middleware and the logging middleware together.
func TestServerRecordsMetricsAndLogs(t *testing.T) {
	var logs bytes.Buffer
	handler := newServer("0", slog.New(slog.NewJSONHandler(&logs, nil))).Handler

	before := testutil.ToFloat64(httpRequestsTotal.WithLabelValues("GET", "other", "404"))

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/no-such-route", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}

	// The 404 comes from http.NotFound calling WriteHeader, so this also proves
	// responseWriter captured the status rather than defaulting to 200.
	after := testutil.ToFloat64(httpRequestsTotal.WithLabelValues("GET", "other", "404"))
	if after != before+1 {
		t.Errorf("http_requests_total{route=other,status_code=404} went %v -> %v, want +1", before, after)
	}
	if !strings.Contains(logs.String(), `"path":"/no-such-route"`) {
		t.Errorf("request was not logged: %s", logs.String())
	}
}

func TestServerDoesNotCountMetricsScrapes(t *testing.T) {
	handler := newServer("0", slog.New(slog.NewJSONHandler(io.Discard, nil))).Handler
	before := testutil.CollectAndCount(httpRequestsTotal)

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 from /metrics, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "http_requests_total") {
		t.Error("/metrics does not expose http_requests_total")
	}
	if after := testutil.CollectAndCount(httpRequestsTotal); after != before {
		t.Errorf("scraping /metrics created a new series (%d -> %d)", before, after)
	}
}
