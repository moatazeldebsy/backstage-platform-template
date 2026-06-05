package main

import (
	"os"
	"path/filepath"
	"testing"
)

// ── resolveBackstageURL ───────────────────────────────────────────────────────

func TestResolveBackstageURL(t *testing.T) {
	dir := t.TempDir()
	localEnv := filepath.Join(dir, "local", ".env")
	if err := os.MkdirAll(filepath.Dir(localEnv), 0o755); err != nil {
		t.Fatal(err)
	}

	unset := func(keys ...string) {
		for _, k := range keys {
			os.Unsetenv(k)
		}
	}

	t.Run("explicit URL always wins", func(t *testing.T) {
		t.Setenv("IDP_BACKSTAGE_URL", "https://should-not-be-used.example.com")
		got := resolveBackstageURL(envAWS, "https://explicit.example.com/", dir)
		if got != "https://explicit.example.com" {
			t.Errorf("got %q, want https://explicit.example.com", got)
		}
	})

	t.Run("local env always returns idp.local default", func(t *testing.T) {
		t.Setenv("IDP_BACKSTAGE_URL", "https://ignored.example.com")
		got := resolveBackstageURL(envLocal, "", dir)
		if got != "http://backstage.idp.local" {
			t.Errorf("got %q, want http://backstage.idp.local", got)
		}
	})

	t.Run("aws: IDP_BACKSTAGE_URL env var", func(t *testing.T) {
		unset("IDP_BACKSTAGE_URL", "BACKSTAGE_URL", "IDP_DOMAIN")
		t.Setenv("IDP_BACKSTAGE_URL", "https://backstage.idp.example.com/")
		got := resolveBackstageURL(envAWS, "", dir)
		if got != "https://backstage.idp.example.com" {
			t.Errorf("got %q, want https://backstage.idp.example.com", got)
		}
	})

	t.Run("aws: BACKSTAGE_URL env var (fallback after IDP_BACKSTAGE_URL)", func(t *testing.T) {
		unset("IDP_BACKSTAGE_URL", "BACKSTAGE_URL", "IDP_DOMAIN")
		t.Setenv("BACKSTAGE_URL", "https://bs.staging.example.com")
		got := resolveBackstageURL(envAWS, "", dir)
		if got != "https://bs.staging.example.com" {
			t.Errorf("got %q, want https://bs.staging.example.com", got)
		}
	})

	t.Run("aws: IDP_DOMAIN constructs URL", func(t *testing.T) {
		unset("IDP_BACKSTAGE_URL", "BACKSTAGE_URL", "IDP_DOMAIN")
		t.Setenv("IDP_DOMAIN", "idp.example.com")
		got := resolveBackstageURL(envAWS, "", dir)
		if got != "https://backstage.idp.example.com" {
			t.Errorf("got %q, want https://backstage.idp.example.com", got)
		}
	})

	t.Run("aws: local/.env lookup", func(t *testing.T) {
		unset("IDP_BACKSTAGE_URL", "BACKSTAGE_URL", "IDP_DOMAIN")
		if err := os.WriteFile(localEnv, []byte("IDP_BACKSTAGE_URL=https://from-file.example.com\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		got := resolveBackstageURL(envAWS, "", dir)
		if got != "https://from-file.example.com" {
			t.Errorf("got %q, want https://from-file.example.com", got)
		}
		os.Remove(localEnv)
	})

	t.Run("aws: falls back to idp.local when nothing set", func(t *testing.T) {
		unset("IDP_BACKSTAGE_URL", "BACKSTAGE_URL", "IDP_DOMAIN")
		got := resolveBackstageURL(envAWS, "", dir)
		if got != "http://backstage.idp.local" {
			t.Errorf("got %q, want http://backstage.idp.local", got)
		}
	})
}

// ── resolveToken ──────────────────────────────────────────────────────────────

func TestResolveToken(t *testing.T) {
	dir := t.TempDir()
	localEnv := filepath.Join(dir, "local", ".env")
	if err := os.MkdirAll(filepath.Dir(localEnv), 0o755); err != nil {
		t.Fatal(err)
	}

	unset := func(keys ...string) {
		for _, k := range keys {
			os.Unsetenv(k)
		}
	}

	t.Run("explicit token always wins", func(t *testing.T) {
		t.Setenv("BACKSTAGE_TOKEN", "env-token")
		got := resolveToken(envAWS, "explicit-token", dir)
		if got != "explicit-token" {
			t.Errorf("got %q, want explicit-token", got)
		}
	})

	t.Run("BACKSTAGE_TOKEN env var", func(t *testing.T) {
		unset("BACKSTAGE_TOKEN", "IDP_BACKSTAGE_TOKEN")
		t.Setenv("BACKSTAGE_TOKEN", "env-token")
		got := resolveToken(envAWS, "", dir)
		if got != "env-token" {
			t.Errorf("got %q, want env-token", got)
		}
	})

	t.Run("aws: IDP_BACKSTAGE_TOKEN env var", func(t *testing.T) {
		unset("BACKSTAGE_TOKEN", "IDP_BACKSTAGE_TOKEN")
		t.Setenv("IDP_BACKSTAGE_TOKEN", "idp-token")
		got := resolveToken(envAWS, "", dir)
		if got != "idp-token" {
			t.Errorf("got %q, want idp-token", got)
		}
	})

	t.Run("aws: local/.env BACKSTAGE_TOKEN lookup", func(t *testing.T) {
		unset("BACKSTAGE_TOKEN", "IDP_BACKSTAGE_TOKEN")
		if err := os.WriteFile(localEnv, []byte("BACKSTAGE_TOKEN=file-token\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		got := resolveToken(envAWS, "", dir)
		if got != "file-token" {
			t.Errorf("got %q, want file-token", got)
		}
		os.Remove(localEnv)
	})

	t.Run("aws: empty when nothing set", func(t *testing.T) {
		unset("BACKSTAGE_TOKEN", "IDP_BACKSTAGE_TOKEN")
		got := resolveToken(envAWS, "", dir)
		if got != "" {
			t.Errorf("got %q, want empty string", got)
		}
	})
}

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
