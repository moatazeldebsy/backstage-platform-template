package backstage

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewClient(t *testing.T) {
	c := NewClient("https://backstage.example.com/", "my-token")
	if c.base != "https://backstage.example.com" {
		t.Errorf("trailing slash not stripped: %q", c.base)
	}
	if c.token != "my-token" {
		t.Errorf("token not stored: %q", c.token)
	}
}

func TestSetHeaders(t *testing.T) {
	t.Run("sets Authorization header when token present", func(t *testing.T) {
		c := NewClient("http://example.com", "secret-token")
		req, _ := http.NewRequest(http.MethodGet, "http://example.com", nil)
		c.setHeaders(req)
		if got := req.Header.Get("Authorization"); got != "Bearer secret-token" {
			t.Errorf("got %q, want Bearer secret-token", got)
		}
	})

	t.Run("does not set Authorization header when token empty", func(t *testing.T) {
		c := NewClient("http://example.com", "")
		req, _ := http.NewRequest(http.MethodGet, "http://example.com", nil)
		c.setHeaders(req)
		if got := req.Header.Get("Authorization"); got != "" {
			t.Errorf("expected no Authorization header, got %q", got)
		}
	})
}

func TestGetEntity(t *testing.T) {
	t.Run("returns decoded entity for 200 response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/catalog/entities/by-name/component/default/hello-service" {
				t.Errorf("unexpected path: %s", r.URL.Path)
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"metadata":{"name":"hello-service","description":"a test"}}`)) //nolint:errcheck
		}))
		defer srv.Close()

		c := NewClient(srv.URL, "")
		entity, err := c.GetEntity(t.Context(), "component", "default", "hello-service")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		metadata, ok := entity["metadata"].(map[string]any)
		if !ok {
			t.Fatalf("expected metadata map, got %#v", entity["metadata"])
		}
		if metadata["name"] != "hello-service" {
			t.Errorf("got name %v, want hello-service", metadata["name"])
		}
	})

	t.Run("returns error for 404 response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte("not found")) //nolint:errcheck
		}))
		defer srv.Close()

		c := NewClient(srv.URL, "")
		if _, err := c.GetEntity(t.Context(), "component", "default", "missing"); err == nil {
			t.Error("expected error for 404 response")
		}
	})
}

func TestHealthy(t *testing.T) {
	t.Run("returns true for 200 response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/healthcheck" {
				w.WriteHeader(http.StatusOK)
			} else {
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		defer srv.Close()
		c := NewClient(srv.URL, "")
		if !c.Healthy(t.Context()) {
			t.Error("expected Healthy() to return true")
		}
	})

	t.Run("returns false for 503 response", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		}))
		defer srv.Close()
		c := NewClient(srv.URL, "")
		if c.Healthy(t.Context()) {
			t.Error("expected Healthy() to return false")
		}
	})

	t.Run("returns false when server unreachable", func(t *testing.T) {
		c := NewClient("http://localhost:1", "")
		if c.Healthy(t.Context()) {
			t.Error("expected Healthy() to return false for unreachable server")
		}
	})
}

func TestHandleEvent(t *testing.T) {
	c := NewClient("http://localhost", "")

	t.Run("log event returns false, nil", func(t *testing.T) {
		raw := `{"type":"log","body":{"message":"Step running","stepId":"step-1"}}`
		done, err := c.handleEvent(raw)
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if done {
			t.Error("expected done=false for log event")
		}
	})

	t.Run("completion with status completed returns true, nil", func(t *testing.T) {
		raw := `{"type":"completion","body":{"message":"Run completed with status: completed"}}`
		done, err := c.handleEvent(raw)
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if !done {
			t.Error("expected done=true for completed status")
		}
	})

	t.Run("completion with status failed returns error", func(t *testing.T) {
		raw := `{"type":"completion","body":{"message":"Run completed with status: failed"}}`
		done, err := c.handleEvent(raw)
		if err == nil {
			t.Error("expected error for failed status")
		}
		if done {
			t.Error("expected done=false on failure")
		}
		if !strings.Contains(err.Error(), "failed") {
			t.Errorf("error should mention failed, got: %v", err)
		}
	})

	t.Run("completion failed uses error.message field when present", func(t *testing.T) {
		raw := `{"type":"completion","body":{"message":"Run completed with status: failed","error":{"message":"template missing"}}}`
		_, err := c.handleEvent(raw)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "template missing") {
			t.Errorf("error should contain error.message, got: %v", err)
		}
	})

	t.Run("completion with cancelled status returns error", func(t *testing.T) {
		raw := `{"type":"completion","body":{"message":"Run completed with status: cancelled"}}`
		done, err := c.handleEvent(raw)
		if err == nil {
			t.Error("expected error for cancelled status")
		}
		if done {
			t.Error("expected done=false on cancelled")
		}
		if !strings.Contains(err.Error(), "cancelled") {
			t.Errorf("error should mention cancelled, got: %v", err)
		}
	})

	t.Run("malformed JSON is silently ignored", func(t *testing.T) {
		done, err := c.handleEvent("{not valid json")
		if err != nil {
			t.Errorf("malformed JSON should be ignored, got: %v", err)
		}
		if done {
			t.Error("expected done=false for malformed event")
		}
	})

	t.Run("unknown event type returns false, nil", func(t *testing.T) {
		raw := `{"type":"info","body":{"message":"some info"}}`
		done, err := c.handleEvent(raw)
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if done {
			t.Error("expected done=false for unknown event type")
		}
	})
}

func TestScaffoldService(t *testing.T) {
	t.Run("returns error when API returns 400", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"bad request"}`)) //nolint:errcheck
		}))
		defer srv.Close()
		c := NewClient(srv.URL, "")
		err := c.ScaffoldService(t.Context(), ScaffoldRequest{
			Name: "my-svc", Type: "go", Namespace: "services",
			Owner: "team-platform", GHOrg: "myorg",
		})
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "400") {
			t.Errorf("error should mention 400, got: %v", err)
		}
	})

	t.Run("creates task and streams to completion", func(t *testing.T) {
		ssePayload := "data:{\"type\":\"log\",\"body\":{\"message\":\"Running\",\"stepId\":\"s1\"}}\n\n" +
			"data:{\"type\":\"completion\",\"body\":{\"message\":\"Run completed with status: completed\"}}\n\n"

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/tasks"):
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				w.Write([]byte(`{"id":"task-abc-123"}`)) //nolint:errcheck
			case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/eventstream"):
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(ssePayload)) //nolint:errcheck
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		defer srv.Close()
		c := NewClient(srv.URL, "tok")
		err := c.ScaffoldService(t.Context(), ScaffoldRequest{
			Name: "my-svc", Type: "go", Namespace: "services",
			Owner: "team-platform", GHOrg: "myorg",
		})
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})

	t.Run("returns error when task fails in event stream", func(t *testing.T) {
		ssePayload := "data:{\"type\":\"completion\",\"body\":{\"message\":\"Run completed with status: failed\"," +
			"\"error\":{\"message\":\"step blew up\"}}}\n\n"

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost:
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				w.Write([]byte(`{"id":"task-fail-123"}`)) //nolint:errcheck
			case http.MethodGet:
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(ssePayload)) //nolint:errcheck
			}
		}))
		defer srv.Close()
		c := NewClient(srv.URL, "")
		err := c.ScaffoldService(t.Context(), ScaffoldRequest{Name: "bad-svc", Type: "go"})
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "step blew up") {
			t.Errorf("error should mention step blew up, got: %v", err)
		}
	})
}

func TestScaffoldTestSuite(t *testing.T) {
	t.Run("includes optional pact fields when set", func(t *testing.T) {
		var capturedBody []byte
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost:
				capturedBody = make([]byte, r.ContentLength)
				r.Body.Read(capturedBody) //nolint:errcheck
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				w.Write([]byte(`{"id":"task-pact-1"}`)) //nolint:errcheck
			case http.MethodGet:
				ssePayload := "data:{\"type\":\"completion\",\"body\":{\"message\":\"Run completed with status: completed\"}}\n\n"
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write([]byte(ssePayload)) //nolint:errcheck
			}
		}))
		defer srv.Close()
		c := NewClient(srv.URL, "")
		err := c.ScaffoldTestSuite(t.Context(), TestSuiteRequest{
			Name:         "pact-suite",
			TemplateRef:  "pact-contract-suite",
			Service:      "payment-service",
			GHOrg:        "myorg",
			Owner:        "team-platform",
			ConsumerName: "frontend",
			ProviderName: "payment-service",
		})
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		body := string(capturedBody)
		if !strings.Contains(body, "consumerName") {
			t.Error("expected consumerName in request body")
		}
		if !strings.Contains(body, "providerName") {
			t.Error("expected providerName in request body")
		}
	})

	t.Run("omits optional fields when not set", func(t *testing.T) {
		var capturedBody []byte
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost:
				capturedBody = make([]byte, r.ContentLength)
				r.Body.Read(capturedBody) //nolint:errcheck
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				w.Write([]byte(`{"id":"task-e2e-1"}`)) //nolint:errcheck
			case http.MethodGet:
				ssePayload := "data:{\"type\":\"completion\",\"body\":{\"message\":\"Run completed with status: completed\"}}\n\n"
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write([]byte(ssePayload)) //nolint:errcheck
			}
		}))
		defer srv.Close()
		c := NewClient(srv.URL, "")
		err := c.ScaffoldTestSuite(t.Context(), TestSuiteRequest{
			Name:        "e2e-suite",
			TemplateRef: "playwright-e2e-suite",
			Service:     "my-service",
			GHOrg:       "myorg",
		})
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		body := string(capturedBody)
		if strings.Contains(body, "consumerName") {
			t.Error("expected no consumerName when not set")
		}
		if strings.Contains(body, "datadogSite") {
			t.Error("expected no datadogSite when not set")
		}
		if strings.Contains(body, "deviceFarm") {
			t.Error("expected no deviceFarm when not set")
		}
	})

	t.Run("forwards deviceFarm for appium suites", func(t *testing.T) {
		var capturedBody []byte
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost:
				capturedBody = make([]byte, r.ContentLength)
				r.Body.Read(capturedBody) //nolint:errcheck
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				w.Write([]byte(`{"id":"task-appium-1"}`)) //nolint:errcheck
			case http.MethodGet:
				ssePayload := "data:{\"type\":\"completion\",\"body\":{\"message\":\"Run completed with status: completed\"}}\n\n"
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write([]byte(ssePayload)) //nolint:errcheck
			}
		}))
		defer srv.Close()
		c := NewClient(srv.URL, "")
		err := c.ScaffoldTestSuite(t.Context(), TestSuiteRequest{
			Name:        "mobile-suite",
			TemplateRef: "appium-mobile-suite",
			Service:     "my-app",
			GHOrg:       "myorg",
			DeviceFarm:  "lambdatest",
		})
		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		body := string(capturedBody)
		// Without this value the template silently falls back to local-emulator,
		// which is the drift that made the cloud farms unusable before.
		if !strings.Contains(body, `"deviceFarm":"lambdatest"`) {
			t.Errorf("expected deviceFarm=lambdatest in request body, got: %s", body)
		}
	})
}
