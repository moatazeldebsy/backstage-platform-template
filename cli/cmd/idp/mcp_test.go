package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProbeMcpServer_Healthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	status, latency, err := probeMcpServer(srv.URL)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if status != "up" {
		t.Errorf("status = %q, want up", status)
	}
	if latency == "-" || latency == "" {
		t.Errorf("expected a latency value, got %q", latency)
	}
}

func TestProbeMcpServer_FallsBackToRoot(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	status, _, err := probeMcpServer(srv.URL)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if status != "up" {
		t.Errorf("status = %q, want up", status)
	}
}

func TestProbeMcpServer_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	status, latency, err := probeMcpServer(srv.URL)
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	if status != "down" || latency != "-" {
		t.Errorf("status=%q latency=%q, want down/-", status, latency)
	}
}

func TestProbeMcpServer_Unreachable(t *testing.T) {
	status, latency, err := probeMcpServer("http://127.0.0.1:1")
	if err == nil {
		t.Fatal("expected error for unreachable server")
	}
	if status != "down" || latency != "-" {
		t.Errorf("status=%q latency=%q, want down/-", status, latency)
	}
}

func TestMcpServerURL(t *testing.T) {
	mcpEnv = envLocal
	if got := mcpServerURL("idp-mcp-server"); got != "http://idp-mcp-server.idp.local" {
		t.Errorf("got %q, want http://idp-mcp-server.idp.local", got)
	}

	mcpEnv = envAWS
	t.Setenv("IDP_DOMAIN", "idp.example.com")
	if got := mcpServerURL("idp-mcp-server"); got != "https://idp-mcp-server.idp.example.com" {
		t.Errorf("got %q, want https://idp-mcp-server.idp.example.com", got)
	}
	mcpEnv = envLocal
}

func TestMcpServers_CoversPlatform(t *testing.T) {
	// Keep in sync with the MCP targets in kubernetes/ml-platform/ai-gateway.yaml
	// and the AI entries in local/hosts-append.txt.
	want := []string{
		"ai-gateway", "litellm",
		"idp-mcp-server", "qa-mcp-server", "contract-mcp-server", "argocd-mcp-server",
		"github-mcp-server", "cost-mcp-server", "agent-event-router",
		"incident-mcp-server", "security-mcp-server", "approval-service",
	}
	got := map[string]mcpServer{}
	for _, s := range mcpServers {
		got[s.name] = s
	}
	for _, name := range want {
		s, ok := got[name]
		if !ok {
			t.Errorf("mcpServers is missing %q", name)
			continue
		}
		if !s.alwaysOn && s.note == "" {
			t.Errorf("%q is optional but has no note explaining how to enable it", name)
		}
	}
	for _, name := range []string{"idp-mcp-server", "qa-mcp-server"} {
		if !got[name].alwaysOn {
			t.Errorf("%q should be alwaysOn (ApplicationSet-managed)", name)
		}
	}
}
