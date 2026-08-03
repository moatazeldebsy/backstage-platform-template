package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

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
	if body["service"] != "${{ values.name }}" {
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

func TestHandleOpenAPI(t *testing.T) {
	spec := filepath.Join(t.TempDir(), "openapi.yaml")
	if err := os.WriteFile(spec, []byte("openapi: 3.0.0\ninfo:\n  title: test\n"), 0o600); err != nil {
		t.Fatalf("write spec: %v", err)
	}
	t.Setenv("OPENAPI_SPEC_PATH", spec)

	rr := httptest.NewRecorder()
	handleOpenAPI(rr, httptest.NewRequest(http.MethodGet, "/openapi.json", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["openapi"] != "3.0.0" {
		t.Errorf("spec not served as JSON: %v", body)
	}
}

func TestHandleOpenAPIMissingSpec(t *testing.T) {
	t.Setenv("OPENAPI_SPEC_PATH", filepath.Join(t.TempDir(), "absent.yaml"))

	rr := httptest.NewRecorder()
	handleOpenAPI(rr, httptest.NewRequest(http.MethodGet, "/openapi.json", nil))

	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rr.Code)
	}
}

func TestHandleOpenAPIInvalidSpec(t *testing.T) {
	spec := filepath.Join(t.TempDir(), "openapi.yaml")
	if err := os.WriteFile(spec, []byte("foo: [unclosed\n"), 0o600); err != nil {
		t.Fatalf("write spec: %v", err)
	}
	t.Setenv("OPENAPI_SPEC_PATH", spec)

	rr := httptest.NewRecorder()
	handleOpenAPI(rr, httptest.NewRequest(http.MethodGet, "/openapi.json", nil))

	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

func TestNewMuxRoutes(t *testing.T) {
	mux := newMux()

	for _, path := range []string{"/", "/healthz", "/ready", "/metrics"} {
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
		if rr.Code != http.StatusOK {
			t.Errorf("%s: expected 200, got %d", path, rr.Code)
		}
	}
}

func TestNewServerTimeouts(t *testing.T) {
	srv := newServer("9999", testLogger())

	if srv.Addr != ":9999" {
		t.Errorf("expected addr :9999, got %s", srv.Addr)
	}
	if srv.ReadTimeout != 5*time.Second || srv.WriteTimeout != 10*time.Second || srv.IdleTimeout != 60*time.Second {
		t.Errorf("server timeouts not set as expected: %v/%v/%v",
			srv.ReadTimeout, srv.WriteTimeout, srv.IdleTimeout)
	}
	if srv.Handler == nil {
		t.Error("server handler not wired")
	}
}

func TestLoggingMiddleware(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})

	rr := httptest.NewRecorder()
	loggingMiddleware(testLogger(), next).ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))

	if rr.Code != http.StatusTeapot {
		t.Errorf("middleware changed status: expected 418, got %d", rr.Code)
	}
}

func TestResponseWriterCapturesStatus(t *testing.T) {
	rr := httptest.NewRecorder()
	rw := &responseWriter{ResponseWriter: rr, status: http.StatusOK}
	rw.WriteHeader(http.StatusNotFound)

	if rw.status != http.StatusNotFound {
		t.Errorf("expected captured status 404, got %d", rw.status)
	}
	if rr.Code != http.StatusNotFound {
		t.Errorf("status not passed through: got %d", rr.Code)
	}
}

func TestGetEnv(t *testing.T) {
	if got := getEnv("IDP_TEST_UNSET_VAR", "fallback"); got != "fallback" {
		t.Errorf("expected fallback, got %s", got)
	}
	t.Setenv("IDP_TEST_SET_VAR", "actual")
	if got := getEnv("IDP_TEST_SET_VAR", "fallback"); got != "actual" {
		t.Errorf("expected actual, got %s", got)
	}
}

func TestRunShutsDownOnSignal(t *testing.T) {
	t.Setenv("PORT", "0") // let the kernel pick a free port

	done := make(chan error, 1)
	go func() { done <- run(testLogger()) }()

	// Give the listener a moment to come up before signalling.
	time.Sleep(200 * time.Millisecond)
	if err := syscall.Kill(syscall.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("expected clean shutdown, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not return after SIGTERM")
	}
}
