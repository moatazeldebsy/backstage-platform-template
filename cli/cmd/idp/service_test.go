package main

import (
	"os"
	"path/filepath"
	"testing"
)

// ── nameRe validation ─────────────────────────────────────────────────────────

func TestNameRe(t *testing.T) {
	valid := []string{"a", "my-svc", "order-service-v2", "abc123"}
	for _, n := range valid {
		if !nameRe.MatchString(n) {
			t.Errorf("expected %q to be valid", n)
		}
	}

	invalid := []string{"", "-start", "UPPER", "has_underscore", "has space", "123start"}
	for _, n := range invalid {
		if nameRe.MatchString(n) {
			t.Errorf("expected %q to be invalid", n)
		}
	}
}

// ── keyFromEnvFile ────────────────────────────────────────────────────────────

func TestKeyFromEnvFile(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")

	content := "FOO=bar\nBAZ=qux\n# comment\nEMPTY=\n"
	if err := os.WriteFile(envPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := keyFromEnvFile(envPath, "FOO"); got != "bar" {
		t.Errorf("got %q, want %q", got, "bar")
	}
	if got := keyFromEnvFile(envPath, "BAZ"); got != "qux" {
		t.Errorf("got %q, want %q", got, "qux")
	}
	// empty value → treat as missing
	if got := keyFromEnvFile(envPath, "EMPTY"); got != "" {
		t.Errorf("expected empty for blank value, got %q", got)
	}
	// missing key
	if got := keyFromEnvFile(envPath, "MISSING"); got != "" {
		t.Errorf("expected empty for missing key, got %q", got)
	}
	// non-existent file
	if got := keyFromEnvFile("/no/such/file", "FOO"); got != "" {
		t.Errorf("expected empty for missing file, got %q", got)
	}
}

// ── staticTokenFromConfig ─────────────────────────────────────────────────────

func TestStaticTokenFromConfig(t *testing.T) {
	dir := t.TempDir()

	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}

	// Token present under externalAccess block.
	withToken := write("with-token.yaml", `
backend:
  auth:
    externalAccess:
      - type: static
        options:
          token: "my-secret-token"
          subject: local-cli
`)
	if got := staticTokenFromConfig(withToken); got != "my-secret-token" {
		t.Errorf("got %q, want %q", got, "my-secret-token")
	}

	// No externalAccess section.
	noExternal := write("no-external.yaml", `
backend:
  baseUrl: http://localhost:7007
`)
	if got := staticTokenFromConfig(noExternal); got != "" {
		t.Errorf("expected empty, got %q", got)
	}

	// Non-existent file.
	if got := staticTokenFromConfig("/no/such/file.yaml"); got != "" {
		t.Errorf("expected empty for missing file, got %q", got)
	}
}
