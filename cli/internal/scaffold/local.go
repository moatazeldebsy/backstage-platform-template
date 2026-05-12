package scaffold

import (
	"bufio"
	"embed"
	"fmt"
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
	RootDir      string
	GHOrg        string
	PlatformRepo string
	Port         int
	TestCmd      string
}

// LocalService generates a service scaffold under <RootDir>/services/<Name>.
func LocalService(cfg ServiceConfig) error {
	cfg = applyDefaults(cfg)

	targetDir := filepath.Join(cfg.RootDir, "services", cfg.Name)
	if _, err := os.Stat(targetDir); err == nil {
		return fmt.Errorf("service %q already exists at %s", cfg.Name, targetDir)
	}

	entries := fileEntries(cfg.Type)
	for _, e := range entries {
		if err := renderFile(e.tmpl, filepath.Join(targetDir, e.out), cfg); err != nil {
			_ = os.RemoveAll(targetDir)
			return fmt.Errorf("rendering %s: %w", e.tmpl, err)
		}
	}

	if err := gitCommit(cfg.RootDir, "services/"+cfg.Name); err != nil {
		fmt.Printf("[idp] Warning: git commit/push skipped: %v\n", err)
	}

	fmt.Printf("[idp] Service %q scaffolded at %s\n", cfg.Name, targetDir)
	fmt.Printf("[idp] Next steps:\n")
	fmt.Printf("[idp]   tilt up                     — hot-reload dev loop\n")
	fmt.Printf("[idp]   git push origin main         — triggers CI/CD\n")
	fmt.Printf("[idp]   http://%s.idp.local  — service endpoint\n", cfg.Name)
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
		{"shared/README.md.tmpl", "README.md"},
		{"shared/ci.yml.tmpl", ".github/workflows/ci.yml"},
		{"shared/helm-values.yaml.tmpl", "helm-values.yaml"},
		{"shared/helm-values-local.yaml.tmpl", "helm-values-local.yaml"},
		{"shared/helm-values-dev.yaml.tmpl", "helm-values-dev.yaml"},
		{"shared/helm-values-staging.yaml.tmpl", "helm-values-staging.yaml"},
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
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return err
	}
	t, err := template.New(filepath.Base(src)).Delims("<%", "%>").Parse(string(content))
	if err != nil {
		return fmt.Errorf("parse template: %w", err)
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
	testCmds := map[string]string{
		"nodejs": "npm test",
		"python": "pip install -r requirements.txt && pytest src/ -q",
		"go":     "go test ./src/... -coverprofile=coverage.out -covermode=atomic",
	}
	if cfg.Port == 0 {
		cfg.Port = ports[cfg.Type]
	}
	if cfg.TestCmd == "" {
		cfg.TestCmd = testCmds[cfg.Type]
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
			"backstage-idp-starter",
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
