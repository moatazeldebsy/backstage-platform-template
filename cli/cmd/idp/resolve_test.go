package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveToken_LocalIgnoresSigningKey(t *testing.T) {
	t.Setenv("BACKSTAGE_TOKEN", "")
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("local/backstage/.env", "BACKSTAGE_AUTH_SECRET=signing-key\n")

	// The signing key alone must never be used as a bearer token.
	if got := resolveToken(envLocal, "", root); got != "" {
		t.Errorf("resolveToken = %q, want empty (signing key is not a bearer token)", got)
	}

	write("backstage/app-config.local.yaml", "backend:\n  auth:\n    externalAccess:\n      - type: static\n        options:\n          token: static-tok\n")
	if got := resolveToken(envLocal, "", root); got != "static-tok" {
		t.Errorf("resolveToken = %q, want static-tok", got)
	}
	if got := resolveToken(envLocal, "flag-tok", root); got != "flag-tok" {
		t.Errorf("--token should win, got %q", got)
	}
}
