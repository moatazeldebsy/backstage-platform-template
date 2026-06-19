package main

import (
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
