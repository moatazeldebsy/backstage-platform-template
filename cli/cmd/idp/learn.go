package main

import (
	"fmt"
	"math/rand"
	"sort"
	"time"

	"github.com/YOUR_GITHUB_ORG/backstage-idp-starter/cli/internal/backstage"
	"github.com/spf13/cobra"
)

var tipSeed int64

// tips are real gotchas from this repo's CLAUDE.md, distilled from actual
// incidents — not filler.
var tips = []string{
	"@material-table/core v3.x calls uuid's default export, which uuid v10 removed. The fix is a committed yarn patch — verify it's applied after any `yarn install` (see CLAUDE.md).",
	"Custom Backstage scaffolder action modules must import scaffolderActionsExtensionPoint from @backstage/plugin-scaffolder-node, NOT the /alpha package — the wrong path crashes the scaffolder plugin at startup and leaves the catalog empty.",
	"If refresh_state has rows but final_entities is 0, the catalog refresh loop is stuck — check backstage logs for a scaffolder plugin crash first.",
	"Rancher Desktop users: disable Traefik, set Container Engine to dockerd, and set KUBERNETES_PROVIDER=rancher-desktop in local/.env before running setup.sh.",
	"bootstrap-local.sh only reads local/ + kubernetes/; bootstrap.sh only reads aws/ + kubernetes/. Don't cross-wire config between them.",
	"Adding a proxy target to Backstage? Use the same path key in local and AWS configs, and add the matching pathRewrite — a mismatch produces silent 404s only in production.",
	"contract-mcp-server, agent-event-router, github-mcp-server, argocd-mcp-server, and cost-mcp-server are intentionally excluded from the ApplicationSet — they need bootstrap-ai.sh for image builds and local/.env secrets.",
	"After changing backstage/app/packages/, you must rebuild the Docker image (yarn build runs inside the multi-stage build) — a plain `docker compose restart` only picks up config changes.",
}

var tipCmd = &cobra.Command{
	Use:   "tip",
	Short: "Print a platform onboarding tip",
	RunE:  runTip,
}

var learnCmd = &cobra.Command{
	Use:   "learn",
	Short: "Curated next steps for a catalog entity",
	Long: `Looks up a catalog entity and prints relevant TechDocs links, the matching
test-pyramid row from docs/golden-path.md, and any SLO/Scorecard/Budget tab URLs —
a curated index over content Backstage already serves, not a new content store.`,
	Example: `  idp learn --type component --name hello-service
  idp learn --type template
  idp learn --type group --name platform-team`,
	RunE: runLearn,
}

var (
	learnType string
	learnName string
	learnURL  string
	learnEnv  string
)

func init() {
	tipCmd.Flags().Int64Var(&tipSeed, "seed", 0, "Seed the tip selection (0 = random, based on current time)")

	learnCmd.Flags().StringVar(&learnType, "type", "component", "Entity kind: component | template | group")
	learnCmd.Flags().StringVar(&learnName, "name", "", "Entity name (optional — omit for general guidance for --type)")
	learnCmd.Flags().StringVar(&learnURL, "backstage-url", "", "Backstage base URL")
	learnCmd.Flags().StringVar(&learnEnv, "env", envLocal, fmt.Sprintf("Target environment: %s | %s", envLocal, envAWS))
}

func runTip(_ *cobra.Command, _ []string) error {
	seed := tipSeed
	if seed == 0 {
		seed = time.Now().UnixNano()
	}
	r := rand.New(rand.NewSource(seed)) //nolint:gosec // tip selection, not security-sensitive
	fmt.Println("💡 " + tips[r.Intn(len(tips))])
	return nil
}

// learnResources maps entity kind to curated next-step links, mirroring the
// Backstage entity tabs and golden-path docs already documented in CLAUDE.md.
var learnResources = map[string][]string{
	"component": {
		"TechDocs: open the entity's Docs tab in Backstage for architecture + ADRs",
		"Golden path: see docs/golden-path.md for the test-pyramid template matching this service's stack",
		"SLOs tab: idp.io/slo-availability-target / idp.io/slo-latency-target annotations drive live error-budget gauges",
		"Scorecard tab: run `idp:tech-insights` checks to see this service's Bronze/Silver/Gold status",
		"Run `idp context inject --service <name>` to pull this entity's live annotations into CLAUDE.md",
	},
	"template": {
		"Browse available templates: Backstage → Create → search by kind:template",
		"Adding a new template? See 'Adding a Software Template' in CLAUDE.md for the 3-step registration checklist",
		"Test-suite templates: docs/golden-path.md lists one row per test-pyramid layer with its template name",
	},
	"group": {
		"Budget tab: idp.io/cost-budget-monthly-usd / idp.io/cost-namespace annotations drive the group's cost gauge",
		"Team structure lives in kubernetes/teams/<name>/ — safe to reapply on a new cluster",
	},
}

func runLearn(cmd *cobra.Command, _ []string) error {
	resources, ok := learnResources[learnType]
	if !ok {
		return fmt.Errorf("unknown --type %q (must be component, template, or group)", learnType)
	}

	if learnName != "" {
		fmt.Printf("Next steps for %s:%s\n\n", learnType, learnName)
	} else {
		fmt.Printf("Next steps for kind:%s:\n\n", learnType)
	}
	for _, r := range resources {
		fmt.Println("  • " + r)
	}

	if learnName == "" {
		return nil
	}

	// Best-effort: fetch live annotation values from the catalog to make the
	// generic guidance above concrete for this specific entity.
	url := resolveBackstageURL(learnEnv, learnURL, rootDir())
	token := resolveToken(learnEnv, "", rootDir())
	client := backstage.NewClient(url, token)
	entity, err := client.GetEntity(cmd.Context(), learnType, "default", learnName)
	if err != nil {
		fmt.Printf("\n(could not fetch live annotations for %s: %v)\n", learnName, err)
		return nil
	}
	metadata, _ := entity["metadata"].(map[string]any)
	if metadata == nil {
		return nil
	}
	annotations, _ := metadata["annotations"].(map[string]any)
	if len(annotations) == 0 {
		return nil
	}
	keys := make([]string, 0, len(annotations))
	for k := range annotations {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Println("\nLive annotations:")
	for _, k := range keys {
		fmt.Printf("  %s = %v\n", k, annotations[k])
	}
	return nil
}
