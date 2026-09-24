package scaffold

import (
	"bufio"
	"embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/template"
)

//go:embed templates
var templateFS embed.FS

// ServiceConfig holds everything needed to generate a service scaffold.
type ServiceConfig struct {
	Name         string
	Type         string
	Namespace    string
	Owner        string // catalog owner ref, e.g. group:default/platform-team
	CostCenter   string // cost-center pod label; required by kubernetes/policies/require-cost-tags.yaml
	RootDir      string
	GHOrg        string
	PlatformRepo string
	Port         int
	DryRun       bool
}

// Team is the owner ref reduced to a bare name, for the `team` pod label
// (same reduction as the go-service skeleton's helm-values-local.yaml).
func (c ServiceConfig) Team() string {
	t := strings.TrimPrefix(c.Owner, "group:default/")
	t = strings.TrimPrefix(t, "user:default/")
	return strings.NewReplacer(":", "-", "/", "-").Replace(t)
}

// LocalService generates a service scaffold under <RootDir>/services/<Name>.
func LocalService(cfg ServiceConfig) error {
	cfg = applyDefaults(cfg)

	targetDir := filepath.Join(cfg.RootDir, "services", cfg.Name)
	if !cfg.DryRun {
		if _, err := os.Stat(targetDir); err == nil {
			return fmt.Errorf("service %q already exists at %s", cfg.Name, targetDir)
		}
	}

	entries := fileEntries(cfg.Type)
	for _, e := range entries {
		if err := renderFile(e.tmpl, filepath.Join(targetDir, e.out), cfg); err != nil {
			if !cfg.DryRun {
				_ = os.RemoveAll(targetDir)
			}
			return fmt.Errorf("rendering %s: %w", e.tmpl, err)
		}
	}

	if cfg.DryRun {
		fmt.Printf("[idp] [dry-run] no files written — rerun without --dry-run to scaffold\n")
		return nil
	}

	// build-and-deploy.yml runs `npm ci` (and setup-node caches on the
	// lockfile), both of which fail without a package-lock.json.
	if cfg.Type == "nodejs" {
		if err := npmLockfile(targetDir); err != nil {
			fmt.Printf("[idp] Warning: could not generate package-lock.json (%v) — run `npm install` in services/%s and commit the lockfile, or CI's `npm ci` will fail\n", err, cfg.Name)
		}
	}

	if err := gitCommit(cfg.RootDir, "services/"+cfg.Name); err != nil {
		fmt.Printf("[idp] Warning: git commit/push skipped: %v\n", err)
	}

	fmt.Printf("[idp] Service %q scaffolded at %s\n", cfg.Name, targetDir)
	fmt.Printf("[idp] Next steps:\n")
	fmt.Printf("[idp]   git push origin main — ArgoCD picks up services/%s (build-and-deploy.yml builds it for AWS)\n", cfg.Name)
	fmt.Printf("[idp]   docker build -t localhost:5003/%[1]s:local services/%[1]s && docker push localhost:5003/%[1]s:local\n", cfg.Name)
	fmt.Printf("[idp]     — local image (bootstrap-local.sh also builds it on the next bootstrap)\n")
	fmt.Printf("[idp]   Register in Backstage: /catalog-import → https://github.com/%s/%s/blob/main/services/%s/catalog-info.yaml\n", cfg.GHOrg, cfg.PlatformRepo, cfg.Name)
	fmt.Printf("[idp]   http://%s.idp.local — service endpoint\n", cfg.Name)
	return nil
}

// npmLockfile writes package-lock.json without installing node_modules.
func npmLockfile(dir string) error {
	npm, err := exec.LookPath("npm")
	if err != nil {
		return fmt.Errorf("npm not on PATH")
	}
	cmd := exec.Command(npm, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

type fileEntry struct{ tmpl, out string }

func fileEntries(svcType string) []fileEntry {
	lang := map[string][]fileEntry{
		"nodejs": {
			{"nodejs/package.json.tmpl", "package.json"},
			{"nodejs/src/index.js.tmpl", "src/index.js"},
			{"nodejs/Dockerfile.tmpl", "Dockerfile"},
		},
		"python": {
			{"python/requirements.txt.tmpl", "requirements.txt"},
			{"python/src/main.py.tmpl", "src/main.py"},
			{"python/src/package_init.py.tmpl", "src/__init__.py"}, // go:embed skips names starting with _,
			{"python/src/test_main.py.tmpl", "src/test_main.py"},
			{"python/requirements-dev.txt.tmpl", "requirements-dev.txt"},
			{"python/Dockerfile.tmpl", "Dockerfile"},
		},
		"go": {
			{"go/go.mod.tmpl", "go.mod"},
			{"go/src/main.go.tmpl", "src/main.go"},
			{"go/src/main_test.go.tmpl", "src/main_test.go"},
			{"go/Dockerfile.tmpl", "Dockerfile"},
		},
	}
	shared := []fileEntry{
		// No .github/workflows here: the service lives in the platform repo,
		// where GitHub only runs root-level workflows. build-and-deploy.yml
		// tests, builds, scans and deploys every services/* directory.
		{"shared/README.md.tmpl", "README.md"},
		{"shared/mkdocs.yml.tmpl", "mkdocs.yml"},
		{"shared/docs/index.md.tmpl", "docs/index.md"},
		// No helm-values-staging.yaml: the staging ApplicationSet deploys any
		// service that has one, and build-and-deploy.yml creates it from
		// helm-values-aws.yaml on first promotion. Nor a bare helm-values.yaml —
		// no ApplicationSet reads it.
		{"shared/helm-values-local.yaml.tmpl", "helm-values-local.yaml"},
		{"shared/helm-values-aws.yaml.tmpl", "helm-values-aws.yaml"},
		{"shared/catalog-info.yaml.tmpl", "catalog-info.yaml"},
	}
	return append(lang[svcType], shared...)
}

func renderFile(tmplRelPath, outPath string, data ServiceConfig) error {
	src := "templates/" + tmplRelPath
	content, err := templateFS.ReadFile(src)
	if err != nil {
		return err
	}
	t, err := template.New(filepath.Base(src)).Delims("<%", "%>").Parse(string(content))
	if err != nil {
		return fmt.Errorf("parse template: %w", err)
	}
	if data.DryRun {
		fmt.Printf("[idp] [dry-run] would write %s\n", outPath)
		return t.Execute(io.Discard, data)
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return err
	}
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return t.Execute(f, data)
}

// gitCommit stages and commits the given relPath (e.g. "services/foo" or "test-suites/bar").
func gitCommit(rootDir, relPath string) error {
	run := func(args ...string) error {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = rootDir
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	if err := run("git", "add", relPath+"/"); err != nil {
		return err
	}
	// Only commit if there are staged changes.
	diffCmd := exec.Command("git", "diff", "--cached", "--quiet")
	diffCmd.Dir = rootDir
	if diffCmd.Run() == nil {
		return nil // nothing to commit
	}
	if err := run("git", "commit", "-m", "feat: onboard "+relPath+" to GitOps"); err != nil {
		return err
	}
	_ = run("git", "push") // push is best-effort
	return nil
}

func applyDefaults(cfg ServiceConfig) ServiceConfig {
	ports := map[string]int{"nodejs": 3000, "python": 8000, "go": 8080}
	if cfg.Port == 0 {
		cfg.Port = ports[cfg.Type]
	}
	if cfg.Owner == "" {
		cfg.Owner = "group:default/platform-team"
	}
	if cfg.CostCenter == "" {
		cfg.CostCenter = "eng-platform" // same default as the go/nodejs/python-service templates
	}
	localEnv := cfg.RootDir + "/local/.env"
	if cfg.GHOrg == "" {
		cfg.GHOrg = firstNonEmpty(
			os.Getenv("GITHUB_ORG"),
			os.Getenv("GH_ORG"),
			envOrFromFile(localEnv, "GITHUB_ORG"),
			"YOUR_GITHUB_ORG",
		)
	}
	if cfg.PlatformRepo == "" {
		cfg.PlatformRepo = firstNonEmpty(
			os.Getenv("PLATFORM_REPO"),
			envOrFromFile(localEnv, "PLATFORM_REPO"),
			"backstage-platform-template",
		)
	}
	return cfg
}

// firstNonEmpty returns the first non-empty string from the list.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// envOrFromFile parses a key=value .env file and returns the value for key.
func envOrFromFile(path, key string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if after, ok := strings.CutPrefix(line, key+"="); ok {
			return after
		}
	}
	return ""
}
