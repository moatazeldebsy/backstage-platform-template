package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKagentBaseURL(t *testing.T) {
	t.Run("returns KAGENT_URL when set", func(t *testing.T) {
		t.Setenv("KAGENT_URL", "http://my-kagent:8080")
		got := kagentBaseURL()
		if got != "http://my-kagent:8080" {
			t.Errorf("got %q, want http://my-kagent:8080", got)
		}
	})

	t.Run("returns default when env not set", func(t *testing.T) {
		t.Setenv("KAGENT_URL", "")
		got := kagentBaseURL()
		if got != "http://kagent.idp.local" {
			t.Errorf("got %q, want http://kagent.idp.local", got)
		}
	})
}

func TestToolStatusLabel(t *testing.T) {
	known := map[string]string{
		"list_templates":          "Fetching available templates…",
		"get_template_params":     "Reading template parameters…",
		"scaffold_service":        "Scaffolding service (may take ~60s)…",
		"catalog_search":          "Searching catalog…",
		"catalog_semantic_search": "Semantic catalog search…",
		"get_service_metrics":     "Fetching metrics…",
		"list_deployments":        "Listing deployments…",
		"list_test_suites":        "Fetching test suite catalog…",
		"scaffold_test_suite":     "Scaffolding test suite…",
		"get_user_memory":         "Loading your preferences…",
		"set_user_memory":         "Saving preferences…",
	}
	for tool, want := range known {
		t.Run("known: "+tool, func(t *testing.T) {
			got := toolStatusLabel(tool)
			if got != want {
				t.Errorf("toolStatusLabel(%q) = %q, want %q", tool, got, want)
			}
		})
	}

	t.Run("unknown tool gets generic running label", func(t *testing.T) {
		got := toolStatusLabel("my_custom_tool")
		if !strings.Contains(got, "my_custom_tool") {
			t.Errorf("expected tool name in label, got %q", got)
		}
	})

	t.Run("empty string gets generic label", func(t *testing.T) {
		got := toolStatusLabel("")
		if got == "" {
			t.Error("expected non-empty label for empty tool name")
		}
	})
}

func TestA2ATarget(t *testing.T) {
	if got := a2aTarget("http://kagent", "http://backstage", ""); got != "http://kagent/a2a/kagent/platform-assistant" {
		t.Errorf("without token: got %q", got)
	}
	if got := a2aTarget("http://kagent", "http://backstage", "tok"); got != "http://backstage/api/idp-ai-identity/a2a/kagent/platform-assistant" {
		t.Errorf("with token: got %q", got)
	}
}

func TestPostA2A_Headers(t *testing.T) {
	var gotAuth, gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Run("sends bearer token when set", func(t *testing.T) {
		resp, err := postA2A(srv.Client(), srv.URL, "user-tok", []byte(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if gotAuth != "Bearer user-tok" {
			t.Errorf("Authorization = %q, want Bearer user-tok", gotAuth)
		}
		if gotCT != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", gotCT)
		}
	})

	t.Run("no Authorization header without token", func(t *testing.T) {
		resp, err := postA2A(srv.Client(), srv.URL, "", []byte(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if gotAuth != "" {
			t.Errorf("Authorization = %q, want empty", gotAuth)
		}
	})
}
