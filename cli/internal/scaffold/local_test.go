package scaffold

import (
	"os"
	"path/filepath"
	"strings"
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
				case ".github/workflows/ci.yml", "helm-values-staging.yaml":
					// ci.yml would never run from services/<name>/; a staging
					// values file makes the staging ApplicationSet deploy an
					// image nothing has pushed.
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
			if hasCI {
				t.Errorf("fileEntries(%q) must not emit ci.yml or helm-values-staging.yaml", svcType)
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

	t.Run("sets default owner and cost center", func(t *testing.T) {
		cfg := applyDefaults(ServiceConfig{Type: "go"})
		if cfg.Owner != "group:default/platform-team" || cfg.CostCenter != "eng-platform" {
			t.Errorf("got Owner=%q CostCenter=%q", cfg.Owner, cfg.CostCenter)
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

func TestRenderCatalogInfo_Owner(t *testing.T) {
	cases := map[string]string{
		"":                        "owner: group:default/platform-team",
		"group:default/data-team": "owner: group:default/data-team",
	}
	for owner, want := range cases {
		t.Run("owner="+owner, func(t *testing.T) {
			out := filepath.Join(t.TempDir(), "catalog-info.yaml")
			cfg := applyDefaults(ServiceConfig{Name: "svc", Type: "go", Namespace: "services-dev", Owner: owner, RootDir: t.TempDir()})
			if err := renderFile("shared/catalog-info.yaml.tmpl", out, cfg); err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(out)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(b), want) {
				t.Errorf("catalog-info.yaml missing %q:\n%s", want, b)
			}
		})
	}
}

func TestServiceConfig_Team(t *testing.T) {
	cases := map[string]string{
		"group:default/data-team": "data-team",
		"user:default/jdoe":       "jdoe",
		"platform-team":           "platform-team",
		"group:other/x":           "group-other-x",
	}
	for owner, want := range cases {
		if got := (ServiceConfig{Owner: owner}).Team(); got != want {
			t.Errorf("Team() for %q = %q, want %q", owner, got, want)
		}
	}
}

// Every values file an ApplicationSet deploys into a services-* namespace must
// carry the labels kubernetes/policies/require-cost-tags.yaml enforces.
func TestRenderHelmValues_CostLabels(t *testing.T) {
	cfg := applyDefaults(ServiceConfig{Name: "svc", Type: "go", Namespace: "services-dev", Owner: "group:default/data-team", CostCenter: "cc-42", RootDir: t.TempDir()})
	for _, f := range []string{"helm-values-local.yaml", "helm-values-aws.yaml"} {
		t.Run(f, func(t *testing.T) {
			out := filepath.Join(t.TempDir(), f)
			if err := renderFile("shared/"+f+".tmpl", out, cfg); err != nil {
				t.Fatal(err)
			}
			b, _ := os.ReadFile(out)
			for _, want := range []string{"team: data-team", "cost-center: cc-42", "environment: "} {
				if !strings.Contains(string(b), want) {
					t.Errorf("%s missing %q", f, want)
				}
			}
		})
	}
}

// go:embed silently drops files whose names start with _ or ., so a template
// listed in fileEntries can be missing from the binary without a build error.
func TestFileEntries_AllEmbedded(t *testing.T) {
	for _, svcType := range []string{"nodejs", "python", "go"} {
		for _, e := range fileEntries(svcType) {
			if _, err := templateFS.ReadFile("templates/" + e.tmpl); err != nil {
				t.Errorf("%s: template %s not embedded: %v", svcType, e.tmpl, err)
			}
		}
	}
}
