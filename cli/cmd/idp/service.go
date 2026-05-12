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
	Example: `  # Node.js service (auto-detects Backstage)
  idp scaffold service --name payments-api --type nodejs

  # Python FastAPI service, explicit local generation
  idp scaffold service --name ml-infer --type python --local

  # Go service with a custom namespace
  idp scaffold service --name auth-svc --type go --namespace platform

  # Override Backstage URL (e.g. staging cluster)
  idp scaffold service --name demo-svc --type nodejs --backstage-url http://backstage.staging.local`,
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

// rootDir returns the git repository root, or cwd as fallback.
func rootDir() string {
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err == nil {
		return strings.TrimSpace(string(out))
	}
	dir, _ := os.Getwd()
	return dir
}

// readBackstageToken reads BACKSTAGE_TOKEN env or parses local/backstage/.env.
func readBackstageToken(root string) string {
	if t := os.Getenv("BACKSTAGE_TOKEN"); t != "" {
		return t
	}
	envFile := root + "/local/backstage/.env"
	data, err := os.ReadFile(envFile)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "BACKSTAGE_AUTH_SECRET=") {
			return strings.TrimPrefix(line, "BACKSTAGE_AUTH_SECRET=")
		}
	}
	return ""
}
