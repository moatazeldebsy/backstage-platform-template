package scaffold

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFirstNonEmpty(t *testing.T) {
	cases := []struct {
		vals []string
		want string
	}{
		{[]string{"a", "b", "c"}, "a"},
		{[]string{"", "b", "c"}, "b"},
		{[]string{"", "", "c"}, "c"},
		{[]string{"", "", ""}, ""},
		{[]string{}, ""},
		{[]string{"only"}, "only"},
	}
	for _, tc := range cases {
		got := firstNonEmpty(tc.vals...)
		if got != tc.want {
			t.Errorf("firstNonEmpty(%v) = %q, want %q", tc.vals, got, tc.want)
		}
	}
}

func TestEnvOrFromFile(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	content := "FOO=bar\nBAZ=qux\n# comment\nEMPTY=\n"
	if err := os.WriteFile(envPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := envOrFromFile(envPath, "FOO"); got != "bar" {
		t.Errorf("FOO: got %q, want bar", got)
	}
	if got := envOrFromFile(envPath, "BAZ"); got != "qux" {
		t.Errorf("BAZ: got %q, want qux", got)
	}
	if got := envOrFromFile(envPath, "EMPTY"); got != "" {
		t.Errorf("EMPTY: expected empty string, got %q", got)
	}
	if got := envOrFromFile(envPath, "MISSING"); got != "" {
		t.Errorf("MISSING: expected empty string, got %q", got)
	}
	if got := envOrFromFile("/no/such/file", "FOO"); got != "" {
		t.Errorf("missing file: expected empty string, got %q", got)
	}
}

func TestFileEntries(t *testing.T) {
	for _, svcType := range []string{"nodejs", "python", "go"} {
		t.Run(svcType, func(t *testing.T) {
			entries := fileEntries(svcType)
			if len(entries) == 0 {
				t.Fatalf("fileEntries(%q) returned no entries", svcType)
			}
			hasReadme, hasCI, hasCatalog, hasDockerfile := false, false, false, false
			for _, e := range entries {
				switch e.out {
				case "README.md":
					hasReadme = true
				case ".github/workflows/ci.yml":
					hasCI = true
				case "catalog-info.yaml":
					hasCatalog = true
				case "Dockerfile":
					hasDockerfile = true
				}
			}
			if !hasReadme {
				t.Errorf("fileEntries(%q) missing README.md", svcType)
			}
			if !hasCI {
				t.Errorf("fileEntries(%q) missing .github/workflows/ci.yml", svcType)
			}
			if !hasCatalog {
				t.Errorf("fileEntries(%q) missing catalog-info.yaml", svcType)
			}
			if !hasDockerfile {
				t.Errorf("fileEntries(%q) missing Dockerfile", svcType)
			}
		})
	}

	t.Run("nodejs has package.json", func(t *testing.T) {
		entries := fileEntries("nodejs")
		found := false
		for _, e := range entries {
			if e.out == "package.json" {
				found = true
				break
			}
		}
		if !found {
			t.Error("nodejs entries missing package.json")
		}
	})

	t.Run("go has go.mod and test file", func(t *testing.T) {
		entries := fileEntries("go")
		hasGoMod, hasTest := false, false
		for _, e := range entries {
			if e.out == "go.mod" {
				hasGoMod = true
			}
			if e.out == "src/main_test.go" {
				hasTest = true
			}
		}
		if !hasGoMod {
			t.Error("go entries missing go.mod")
		}
		if !hasTest {
			t.Error("go entries missing src/main_test.go")
		}
	})

	t.Run("unknown type returns only shared files", func(t *testing.T) {
		entries := fileEntries("unknown")
		if len(entries) == 0 {
			t.Error("fileEntries(unknown) should return shared files")
		}
		// Should not have any lang-specific files
		for _, e := range entries {
			if e.out == "package.json" || e.out == "go.mod" || e.out == "requirements.txt" {
				t.Errorf("unexpected lang-specific file %q in unknown type entries", e.out)
			}
		}
	})
}

func TestApplyDefaults(t *testing.T) {
	t.Run("sets default port for nodejs", func(t *testing.T) {
		cfg := applyDefaults(ServiceConfig{Type: "nodejs"})
		if cfg.Port != 3000 {
			t.Errorf("got port %d, want 3000", cfg.Port)
		}
	})

	t.Run("sets default port for python", func(t *testing.T) {
		cfg := applyDefaults(ServiceConfig{Type: "python"})
		if cfg.Port != 8000 {
			t.Errorf("got port %d, want 8000", cfg.Port)
		}
	})

	t.Run("sets default port for go", func(t *testing.T) {
		cfg := applyDefaults(ServiceConfig{Type: "go"})
		if cfg.Port != 8080 {
			t.Errorf("got port %d, want 8080", cfg.Port)
		}
	})

	t.Run("does not override explicit port", func(t *testing.T) {
		cfg := applyDefaults(ServiceConfig{Type: "nodejs", Port: 9999})
		if cfg.Port != 9999 {
			t.Errorf("got port %d, want 9999", cfg.Port)
		}
	})

	t.Run("sets test cmd for nodejs", func(t *testing.T) {
		cfg := applyDefaults(ServiceConfig{Type: "nodejs"})
		if cfg.TestCmd != "npm test" {
			t.Errorf("got TestCmd %q, want 'npm test'", cfg.TestCmd)
		}
	})

	t.Run("sets test cmd for go", func(t *testing.T) {
		cfg := applyDefaults(ServiceConfig{Type: "go"})
		want := "go test ./src/... -coverprofile=coverage.out -covermode=atomic"
		if cfg.TestCmd != want {
			t.Errorf("got TestCmd %q, want %q", cfg.TestCmd, want)
		}
	})

	t.Run("does not override explicit TestCmd", func(t *testing.T) {
		cfg := applyDefaults(ServiceConfig{Type: "nodejs", TestCmd: "make test"})
		if cfg.TestCmd != "make test" {
			t.Errorf("got TestCmd %q, want 'make test'", cfg.TestCmd)
		}
	})

	t.Run("picks up GHOrg from GITHUB_ORG", func(t *testing.T) {
		t.Setenv("GITHUB_ORG", "my-org")
		t.Setenv("GH_ORG", "")
		cfg := applyDefaults(ServiceConfig{Type: "nodejs"})
		if cfg.GHOrg != "my-org" {
			t.Errorf("got GHOrg %q, want my-org", cfg.GHOrg)
		}
	})

	t.Run("falls back to GH_ORG when GITHUB_ORG not set", func(t *testing.T) {
		t.Setenv("GITHUB_ORG", "")
		t.Setenv("GH_ORG", "gh-org")
		cfg := applyDefaults(ServiceConfig{Type: "nodejs"})
		if cfg.GHOrg != "gh-org" {
			t.Errorf("got GHOrg %q, want gh-org", cfg.GHOrg)
		}
	})

	t.Run("falls back to YOUR_GITHUB_ORG placeholder", func(t *testing.T) {
		t.Setenv("GITHUB_ORG", "")
		t.Setenv("GH_ORG", "")
		t.Setenv("PLATFORM_REPO", "")
		cfg := applyDefaults(ServiceConfig{Type: "nodejs"})
		if cfg.GHOrg != "YOUR_GITHUB_ORG" {
			t.Errorf("got GHOrg %q, want YOUR_GITHUB_ORG", cfg.GHOrg)
		}
	})

	t.Run("does not override explicit GHOrg", func(t *testing.T) {
		t.Setenv("GITHUB_ORG", "env-org")
		cfg := applyDefaults(ServiceConfig{Type: "nodejs", GHOrg: "explicit-org"})
		if cfg.GHOrg != "explicit-org" {
			t.Errorf("got GHOrg %q, want explicit-org", cfg.GHOrg)
		}
	})

	t.Run("picks up PlatformRepo from env", func(t *testing.T) {
		t.Setenv("PLATFORM_REPO", "custom-platform")
		cfg := applyDefaults(ServiceConfig{Type: "go"})
		if cfg.PlatformRepo != "custom-platform" {
			t.Errorf("got PlatformRepo %q, want custom-platform", cfg.PlatformRepo)
		}
	})

	t.Run("falls back to backstage-platform-template default", func(t *testing.T) {
		t.Setenv("PLATFORM_REPO", "")
		cfg := applyDefaults(ServiceConfig{Type: "go"})
		if cfg.PlatformRepo != "backstage-platform-template" {
			t.Errorf("got PlatformRepo %q, want backstage-platform-template", cfg.PlatformRepo)
		}
	})
}
