package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
	"github.com/moatazeldebsy/backstage-idp-starter/cli/internal/backstage"
	"github.com/moatazeldebsy/backstage-idp-starter/cli/internal/scaffold"
)

var (
	svcName      string
	svcType      string
	svcNamespace string
	svcLocal     bool
	svcURL       string
	svcOwner     string
	svcDesc      string
)

var nameRe = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

var serviceCmd = &cobra.Command{
	Use:   "service",
	Short: "Scaffold a new microservice",
	Long: `Scaffold a new microservice (nodejs, python, or go).

When Backstage is reachable the Scaffolder API is used (full golden path:
GitHub repo, TechDocs, catalog registration, GitOps PR). When offline,
files are generated locally inside services/<name>/.`,
	Example: `  # Node.js service (auto-detects Backstage at http://backstage.idp.local)
  idp scaffold service --name order-svc --type nodejs

  # Python FastAPI service, force local generation (offline / pre-Backstage)
  idp scaffold service --name data-pipeline --type python --local

  # Go service — same stack as hello-service
  idp scaffold service --name inventory-svc --type go

  # Explicit token when BACKSTAGE_AUTH_SECRET is set in local/backstage/.env
  idp scaffold service --name billing-svc --type nodejs --token local-catalog-exporter-token`,
	RunE: runScaffoldService,
}

func init() {
	serviceCmd.Flags().StringVar(&svcName, "name", "", "Service name — lowercase alphanumeric + hyphens (required)")
	serviceCmd.Flags().StringVar(&svcType, "type", "nodejs", "Service type: nodejs | python | go")
	serviceCmd.Flags().StringVar(&svcNamespace, "namespace", "services", "Kubernetes namespace")
	serviceCmd.Flags().BoolVar(&svcLocal, "local", false, "Skip Backstage API, generate files locally")
	serviceCmd.Flags().StringVar(&svcURL, "backstage-url", "http://backstage.idp.local", "Backstage base URL")
	serviceCmd.Flags().StringVar(&svcOwner, "owner", "group:default/platform-team", "Backstage catalog owner ref")
	serviceCmd.Flags().StringVar(&svcDesc, "description", "", "Short description (used by Backstage template)")
	_ = serviceCmd.MarkFlagRequired("name")
}

func runScaffoldService(cmd *cobra.Command, _ []string) error {
	if !nameRe.MatchString(svcName) {
		return fmt.Errorf("--name must be lowercase alphanumeric with hyphens (got %q)", svcName)
	}
	valid := map[string]bool{"nodejs": true, "python": true, "go": true}
	if !valid[svcType] {
		return fmt.Errorf("--type must be nodejs, python, or go (got %q)", svcType)
	}

	if !svcLocal {
		client := backstage.NewClient(svcURL, readBackstageToken(rootDir()))
		if client.Healthy(cmd.Context()) {
			fmt.Printf("[idp] Backstage reachable at %s — using Scaffolder API\n", svcURL)
			if svcDesc == "" {
				svcDesc = "Auto-scaffolded " + svcType + " service"
			}
			return client.ScaffoldService(cmd.Context(), backstage.ScaffoldRequest{
				Name:      svcName,
				Type:      svcType,
				Namespace: svcNamespace,
				Owner:     svcOwner,
				Desc:      svcDesc,
				GHOrg:     ghOrg(),
			})
		}
		fmt.Println("[idp] Backstage not reachable — falling back to local generation")
	}

	return scaffold.LocalService(scaffold.ServiceConfig{
		Name:      svcName,
		Type:      svcType,
		Namespace: svcNamespace,
		RootDir:   rootDir(),
	})
}

// ghOrg returns the GitHub org, warning if it falls back to the placeholder.
func ghOrg() string {
	for _, key := range []string{"GITHUB_ORG", "GH_ORG"} {
		if v := os.Getenv(key); v != "" {
			return v
		}
	}
	if v := keyFromEnvFile(rootDir()+"/local/.env", "GITHUB_ORG"); v != "" {
		return v
	}
	fmt.Fprintln(os.Stderr, "[idp] Warning: GitHub org not found — set GITHUB_ORG or add it to local/.env")
	return "YOUR_GITHUB_ORG"
}

// rootDir returns the git repository root, or cwd as fallback.
func rootDir() string {
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err == nil {
		return strings.TrimSpace(string(out))
	}
	dir, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[idp] Warning: could not determine working directory:", err)
		return "."
	}
	return dir
}

// readBackstageToken resolves a Backstage service token from (in priority order):
//  1. --token flag
//  2. BACKSTAGE_TOKEN env var
//  3. BACKSTAGE_AUTH_SECRET in local/backstage/.env  (skip if empty)
//  4. The first static externalAccess token in backstage/app-config.local.yaml
func readBackstageToken(root string) string {
	// 1. explicit flag (set by caller before this is invoked)
	if scaffoldToken != "" {
		return scaffoldToken
	}
	// 2. env var
	if t := os.Getenv("BACKSTAGE_TOKEN"); t != "" {
		return t
	}
	// 3. local/backstage/.env → BACKSTAGE_AUTH_SECRET
	if t := keyFromEnvFile(root+"/local/backstage/.env", "BACKSTAGE_AUTH_SECRET"); t != "" {
		return t
	}
	// 4. backstage/app-config.local.yaml → backend.auth.externalAccess static token
	if t := staticTokenFromConfig(root + "/backstage/app-config.local.yaml"); t != "" {
		fmt.Printf("[idp] Using static token from app-config.local.yaml\n")
		return t
	}
	return ""
}

func keyFromEnvFile(path, key string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	prefix := key + "="
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, prefix); ok && v != "" {
			return v
		}
	}
	return ""
}

// staticTokenFromConfig parses the first static externalAccess token from
// a Backstage YAML config without importing a YAML library.
func staticTokenFromConfig(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	inExternal := false
	for _, line := range strings.Split(string(data), "\n") {
		if strings.Contains(line, "externalAccess") {
			inExternal = true
			continue
		}
		if inExternal && strings.Contains(line, "token:") {
			// Extract value between quotes or after the colon.
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				v := strings.TrimSpace(parts[1])
				v = strings.Trim(v, `"'`)
				if v != "" {
					return v
				}
			}
		}
		// Stop at next top-level key (unindented, non-comment line).
		if inExternal && len(line) > 0 && line[0] != ' ' && line[0] != '\t' && line[0] != '#' && line[0] != '-' {
			inExternal = false
		}
	}
	return ""
}
