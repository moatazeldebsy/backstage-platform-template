package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderContextBlock(t *testing.T) {
	entity := map[string]any{
		"metadata": map[string]any{
			"description": "A test service",
			"annotations": map[string]any{
				"idp.io/slo-availability-target": "99.9",
				"pagerduty.com/service-id":       "P123",
			},
		},
	}
	block := renderContextBlock("hello-service", entity)

	if !strings.HasPrefix(block, contextBlockStart) {
		t.Error("block does not start with contextBlockStart")
	}
	if !strings.HasSuffix(block, contextBlockEnd) {
		t.Error("block does not end with contextBlockEnd")
	}
	if !strings.Contains(block, "A test service") {
		t.Error("block missing description")
	}
	if !strings.Contains(block, "idp.io/slo-availability-target") {
		t.Error("block missing SLO annotation")
	}
	if !strings.Contains(block, "P123") {
		t.Error("block missing pagerduty annotation value")
	}
}

func TestWriteContextBlock_CreateThenIdempotentUpdate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "CLAUDE.md")

	block1 := contextBlockStart + "\nfirst\n" + contextBlockEnd
	if err := writeContextBlock(path, block1); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "first") {
		t.Fatalf("expected block written, got %q", got)
	}

	// Re-running with a new block must replace, not duplicate.
	block2 := contextBlockStart + "\nsecond\n" + contextBlockEnd
	if err := writeContextBlock(path, block2); err != nil {
		t.Fatal(err)
	}
	got, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := string(got)
	if strings.Contains(content, "first") {
		t.Errorf("expected old block content to be replaced, got %q", content)
	}
	if !strings.Contains(content, "second") {
		t.Errorf("expected new block content, got %q", content)
	}
	if strings.Count(content, contextBlockStart) != 1 {
		t.Errorf("expected exactly one context block, got content %q", content)
	}
}

func TestWriteContextBlock_PreservesHandWrittenContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "CLAUDE.md")
	initial := "# My hand-written notes\n\nSome important context.\n"
	if err := os.WriteFile(path, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}

	block := contextBlockStart + "\ninjected\n" + contextBlockEnd
	if err := writeContextBlock(path, block); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := string(got)
	if !strings.Contains(content, "My hand-written notes") {
		t.Errorf("expected hand-written content preserved, got %q", content)
	}
	if !strings.Contains(content, "injected") {
		t.Errorf("expected injected block present, got %q", content)
	}
}

func TestServiceNameFromCatalogInfo(t *testing.T) {
	dir := t.TempDir()
	content := `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: hello-service
  description: test
spec:
  type: service
`
	if err := os.WriteFile(filepath.Join(dir, "catalog-info.yaml"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := serviceNameFromCatalogInfo(dir); got != "hello-service" {
		t.Errorf("got %q, want hello-service", got)
	}

	if got := serviceNameFromCatalogInfo(t.TempDir()); got != "" {
		t.Errorf("expected empty for missing catalog-info.yaml, got %q", got)
	}
}
