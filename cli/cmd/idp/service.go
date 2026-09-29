package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"

	"github.com/YOUR_GITHUB_ORG/backstage-idp-starter/cli/internal/backstage"
	"github.com/YOUR_GITHUB_ORG/backstage-idp-starter/cli/internal/scaffold"
	"github.com/spf13/cobra"
)

var (
	svcName        string
	svcType        string
	svcNamespace   string
	svcLocal       bool
	svcDryRun      bool
	svcURL         string
	svcOwner       string
	svcCostCenter  string
	svcDesc        string
	svcClusterName string
	svcRegion      string
)

var nameRe = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// serviceTemplateRef maps --type to the Backstage golden-path template.
var serviceTemplateRef = map[string]string{
	"nodejs": "nodejs-service",
	"python": "python-service",
	"go":     "go-service",
	"jvm":    "jvm-service",
	"ruby":   "ruby-service",
	"react":  "react-frontend",
}

// localServiceTypes have an offline generator in internal/scaffold/templates/.
var localServiceTypes = map[string]bool{"nodejs": true, "python": true, "go": true}

const maxServiceNameLen = 45

var serviceCmd = &cobra.Command{
	Use:   "service",
	Short: "Scaffold a new microservice",
	Long: `Scaffold a new service in a new GitHub repo (greenfield).

Types: nodejs | python | go | jvm | ruby | react

When Backstage is reachable the Scaffolder API is used (full golden path:
GitHub repo, TechDocs, catalog registration, GitOps PR). When offline,
files are generated locally inside services/<name>/ — only nodejs, python
and go have a local generator; jvm, ruby and react need Backstage.

To add tests or scanning to an existing repo (brownfield), use
'idp scaffold test-suite --target-repo' or 'idp template run'.`,
	Example: `  # Node.js service (auto-detects Backstage at http://backstage.idp.local)
  idp scaffold service --name order-svc --type nodejs

  # Python FastAPI service, force local generation (offline / pre-Backstage)
  idp scaffold service --name data-pipeline --type python --local

  # Go service — same stack as hello-service
  idp scaffold service --name inventory-svc --type go

  # Spring Boot service deployed to EKS
  idp scaffold service --name ledger-svc --type jvm --env aws --cluster-name idp-mvp

  # Explicit token (overrides the static externalAccess token auto-detected from app-config.local.yaml)
  idp scaffold service --name billing-svc --type nodejs --token local-catalog-exporter-token`,
	RunE: runScaffoldService,
}

func init() {
	serviceCmd.Flags().StringVar(&svcName, "name", "", "Service name — lowercase alphanumeric + hyphens (required)")
	serviceCmd.Flags().StringVar(&svcType, "type", "nodejs", "Service type: nodejs | python | go | jvm | ruby | react")
	serviceCmd.Flags().StringVar(&svcClusterName, "cluster-name", "idp-mvp", "EKS cluster name (--env aws only; matches the ECR repo prefix)")
	serviceCmd.Flags().StringVar(&svcRegion, "aws-region", "", "AWS region (--env aws only; default: AWS_REGION or us-east-1)")
	serviceCmd.Flags().StringVar(&svcNamespace, "namespace", "services-dev", "Kubernetes namespace (the local/dev ArgoCD ApplicationSet deploys to services-dev)")
	serviceCmd.Flags().BoolVar(&svcLocal, "local", false, "Skip Backstage API, generate files locally")
	serviceCmd.Flags().BoolVar(&svcDryRun, "dry-run", false, "Print files that would be generated without writing them")
	serviceCmd.Flags().StringVar(&svcURL, "backstage-url", "", "Backstage base URL (auto-resolved from IDP_BACKSTAGE_URL / IDP_DOMAIN when --env aws)")
	serviceCmd.Flags().StringVar(&svcOwner, "owner", "group:default/platform-team", "Backstage catalog owner ref")
	serviceCmd.Flags().StringVar(&svcCostCenter, "cost-center", "eng-platform", "cost-center pod label (required by the require-cost-tags policy)")
	serviceCmd.Flags().StringVar(&svcDesc, "description", "", "Short description (used by Backstage template)")
	_ = serviceCmd.MarkFlagRequired("name")
}

func runScaffoldService(cmd *cobra.Command, _ []string) error {
	if !nameRe.MatchString(svcName) {
		return fmt.Errorf("--name must be lowercase alphanumeric with hyphens (got %q)", svcName)
	}
	// Same limit as the Backstage templates: Helm caps release names at 53
	// characters and the staging ApplicationSet deploys <name>-staging.
	if len(svcName) > maxServiceNameLen {
		return fmt.Errorf("--name must be at most %d characters (got %d): the staging release is %s-staging and Helm allows 53", maxServiceNameLen, len(svcName), svcName)
	}
	ref, ok := serviceTemplateRef[svcType]
	if !ok {
		return fmt.Errorf("--type must be one of nodejs, python, go, jvm, ruby, react (got %q)", svcType)
	}
	if svcLocal && !localServiceTypes[svcType] {
		return fmt.Errorf("--type %s has no local generator; remove --local and make sure Backstage is reachable", svcType)
	}

	if !svcLocal && !svcDryRun {
		url := resolveBackstageURL(scaffoldEnv, svcURL, rootDir())
		token := resolveToken(scaffoldEnv, scaffoldToken, rootDir())
		if scaffoldEnv == envAWS {
			fmt.Printf("[idp] Environment: aws — Backstage at %s\n", url)
		}
		client := backstage.NewClient(url, token)
		if client.Healthy(cmd.Context()) {
			fmt.Printf("[idp] Backstage reachable at %s — using Scaffolder API\n", url)
			if svcDesc == "" {
				svcDesc = "Auto-scaffolded " + svcType + " service"
			}
			return client.ScaffoldService(cmd.Context(), backstage.ScaffoldRequest{
				Name:         svcName,
				TemplateRef:  ref,
				Owner:        svcOwner,
				Desc:         svcDesc,
				GHOrg:        ghOrg(),
				CostCenter:   svcCostCenter,
				DeployTarget: scaffoldEnv,
				ClusterName:  svcClusterName,
				AWSRegion:    awsRegion(svcRegion),
			})
		}
		if !localServiceTypes[svcType] {
			return fmt.Errorf("Backstage is not reachable at %s and --type %s has no local generator", url, svcType)
		}
		fmt.Println("[idp] Backstage not reachable — falling back to local generation")
	}
	if !localServiceTypes[svcType] {
		return fmt.Errorf("--type %s has no local generator, so --dry-run can't preview it; run without --dry-run against Backstage", svcType)
	}

	return scaffold.LocalService(scaffold.ServiceConfig{
		Name:       svcName,
		Type:       svcType,
		Namespace:  svcNamespace,
		Owner:      svcOwner,
		CostCenter: svcCostCenter,
		RootDir:    rootDir(),
		DryRun:     svcDryRun,
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

// awsRegion returns explicit, else AWS_REGION (env or local/.env), else us-east-1.
func awsRegion(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if v := os.Getenv("AWS_REGION"); v != "" {
		return v
	}
	if v := keyFromEnvFile(rootDir()+"/local/.env", "AWS_REGION"); v != "" {
		return v
	}
	return "us-east-1"
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
