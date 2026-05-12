package main

import (
	"fmt"

	"github.com/moatazeldebsy/backstage-idp-starter/cli/internal/backstage"
	"github.com/moatazeldebsy/backstage-idp-starter/cli/internal/scaffold"
	"github.com/spf13/cobra"
)

// templateRef maps CLI type names to Backstage template IDs.
var templateRef = map[string]string{
	"playwright":     "playwright-e2e-suite",
	"k6":             "k6-performance-suite",
	"pact":           "pact-contract-suite",
	"newman":         "newman-api-suite",
	"zap":            "zap-dast-suite",
	"datadog":        "datadog-synthetic-suite",
	"visual":         "visual-regression-suite",
	"accessibility":  "accessibility-suite",
	"cucumber":       "bdd-cucumber-suite",
	"appium":         "appium-mobile-suite",
	"chaos":          "chaos-mesh-suite",
	"mutation":       "mutation-testing-suite",
	"testcontainers": "testcontainers-suite",
}

var (
	tsName      string
	tsType      string
	tsService   string
	tsNamespace string
	tsOwner     string
	tsDesc      string
	tsLocal     bool
	tsURL       string

	// k6
	tsVUs          int
	tsDuration     string
	tsP95Threshold int

	// pact
	tsConsumer    string
	tsProvider    string
	tsBrokerURL   string

	// zap
	tsScanType  string
	tsOpenAPIURL string
	tsFailRisk  string

	// datadog
	tsDDSite string

	// visual
	tsDiffThreshold string

	// accessibility
	tsWCAGLevel string

	// appium
	tsPlatform     string
	tsAppiumServer string

	// chaos
	tsExperiments   string
	tsChaosDuration string

	// mutation
	tsMutationScore int
	tsTestRunner    string

	// testcontainers
	tsContainers string
)

var testSuiteCmd = &cobra.Command{
	Use:   "test-suite",
	Short: "Scaffold a QA test suite",
	Long: `Scaffold a QA/testing suite (playwright, k6, pact, and more).

Uses the Backstage Scaffolder API when reachable; falls back to generating
files locally under test-suites/<name>/.

Supported types: playwright | k6 | pact | newman | zap | datadog | visual |
                 accessibility | cucumber | appium | chaos | mutation | testcontainers`,
	Example: `  # Playwright E2E suite for hello-service
  idp scaffold test-suite --name hello-e2e --type playwright --service hello-service

  # k6 load test — 50 VUs, 5 min, p95 < 300 ms
  idp scaffold test-suite --name hello-load --type k6 --service hello-service \
    --vus 50 --duration 5m --p95 300

  # Pact consumer contract tests
  idp scaffold test-suite --name hello-contracts --type pact --service hello-service \
    --consumer frontend --provider hello-service

  # OWASP ZAP DAST security scan
  idp scaffold test-suite --name hello-sec --type zap --service hello-service \
    --scan-type baseline --target-url http://hello-service.idp.local

  # WCAG 2.1 AA accessibility audit
  idp scaffold test-suite --name hello-a11y --type accessibility --service hello-service \
    --wcag wcag21aa

  # Chaos Mesh resilience experiments
  idp scaffold test-suite --name hello-chaos --type chaos --service hello-service \
    --chaos-duration 2m

  # Stryker mutation testing, 80 % threshold
  idp scaffold test-suite --name hello-mutation --type mutation --service hello-service \
    --score 80

  # Force local generation (offline / pre-Backstage)
  idp scaffold test-suite --name hello-e2e --type playwright --service hello-service --local`,
	RunE: runScaffoldTestSuite,
}

func init() {
	f := testSuiteCmd.Flags()

	f.StringVar(&tsName, "name", "", "Suite name — lowercase alphanumeric + hyphens (required)")
	f.StringVar(&tsType, "type", "", "Suite type (required) — see list above")
	f.StringVar(&tsService, "service", "", "Target service name (required)")
	f.StringVar(&tsNamespace, "namespace", "services", "Kubernetes namespace of the target service")
	f.StringVar(&tsOwner, "owner", "group:default/platform-team", "Backstage catalog owner ref")
	f.StringVar(&tsDesc, "description", "", "Short description (used by Backstage template)")
	f.BoolVar(&tsLocal, "local", false, "Skip Backstage API, generate files locally")
	f.StringVar(&tsURL, "backstage-url", "http://backstage.idp.local", "Backstage base URL")

	// k6
	f.IntVar(&tsVUs, "vus", 10, "k6: number of virtual users")
	f.StringVar(&tsDuration, "duration", "30s", "k6: load test duration (e.g. 1m, 5m)")
	f.IntVar(&tsP95Threshold, "p95", 500, "k6: p95 latency threshold in ms")

	// pact
	f.StringVar(&tsConsumer, "consumer", "", "pact: consumer name (default: <name>-consumer)")
	f.StringVar(&tsProvider, "provider", "", "pact: provider name (default: <service>)")
	f.StringVar(&tsBrokerURL, "broker-url", "https://YOUR_ORG.pactflow.io", "pact: Pact Broker URL")

	// zap
	f.StringVar(&tsScanType, "scan-type", "baseline", "zap: scan type (baseline|full|api|graphql)")
	f.StringVar(&tsOpenAPIURL, "openapi-url", "http://localhost:8080/openapi.json", "zap: OpenAPI spec URL")
	f.StringVar(&tsFailRisk, "fail-risk", "High", "zap: minimum risk level to fail (Low|Medium|High)")

	// datadog
	f.StringVar(&tsDDSite, "dd-site", "datadoghq.eu", "datadog: Datadog site")

	// visual
	f.StringVar(&tsDiffThreshold, "threshold", "0.2", "visual: max pixel diff ratio (0.0–1.0)")

	// accessibility
	f.StringVar(&tsWCAGLevel, "wcag", "wcag2aa", "accessibility: WCAG standard (wcag2a|wcag2aa|wcag21aa|wcag22aa)")

	// appium
	f.StringVar(&tsPlatform, "platform", "android", "appium: mobile platform (android|ios)")
	f.StringVar(&tsAppiumServer, "appium-server", "http://localhost:4723", "appium: Appium server URL")

	// chaos
	f.StringVar(&tsExperiments, "experiments", "pod-failure,network-latency", "chaos: comma-separated experiment types")
	f.StringVar(&tsChaosDuration, "chaos-duration", "1m", "chaos: experiment duration (e.g. 1m, 5m)")

	// mutation
	f.IntVar(&tsMutationScore, "score", 70, "mutation: minimum mutation score percentage")
	f.StringVar(&tsTestRunner, "test-runner", "jest", "mutation: Stryker test runner (jest|mocha|jasmine)")

	// testcontainers
	f.StringVar(&tsContainers, "containers", "postgres", "testcontainers: comma-separated container images")

	_ = testSuiteCmd.MarkFlagRequired("name")
	_ = testSuiteCmd.MarkFlagRequired("type")
	_ = testSuiteCmd.MarkFlagRequired("service")
}

func runScaffoldTestSuite(cmd *cobra.Command, _ []string) error {
	if !nameRe.MatchString(tsName) {
		return fmt.Errorf("--name must be lowercase alphanumeric with hyphens (got %q)", tsName)
	}
	if _, ok := templateRef[tsType]; !ok {
		return fmt.Errorf("unknown --type %q; supported: playwright k6 pact newman zap datadog visual accessibility cucumber appium chaos mutation testcontainers", tsType)
	}

	cfg := scaffold.TestSuiteConfig{
		Name:          tsName,
		Type:          tsType,
		Service:       tsService,
		Namespace:     tsNamespace,
		RootDir:       rootDir(),
		BaseURL:       "http://localhost:3000",
		TargetURL:     "http://localhost:8080",
		VUs:           tsVUs,
		Duration:      tsDuration,
		P95Threshold:  tsP95Threshold,
		ConsumerName:  tsConsumer,
		ProviderName:  tsProvider,
		PactBrokerURL: tsBrokerURL,
		ScanType:      tsScanType,
		OpenAPIURL:    tsOpenAPIURL,
		FailRisk:      tsFailRisk,
		DDSite:        tsDDSite,
		DiffThreshold: tsDiffThreshold,
		WCAGLevel:     tsWCAGLevel,
		Platform:      tsPlatform,
		AppiumServer:  tsAppiumServer,
		Experiments:   tsExperiments,
		ChaosDuration: tsChaosDuration,
		MutationScore: tsMutationScore,
		TestRunner:    tsTestRunner,
		Containers:    tsContainers,
	}

	if !tsLocal {
		client := backstage.NewClient(tsURL, readBackstageToken(rootDir()))
		if client.Healthy(cmd.Context()) {
			fmt.Printf("[idp] Backstage reachable at %s — using Scaffolder API\n", tsURL)
			if tsDesc == "" {
				tsDesc = tsType + " test suite for " + tsService
			}
			return client.ScaffoldTestSuite(cmd.Context(), backstage.TestSuiteRequest{
				Name:         tsName,
				TemplateRef:  templateRef[tsType],
				Service:      tsService,
				Namespace:    tsNamespace,
				GHOrg:        ghOrg(),
				Owner:        tsOwner,
				Desc:         tsDesc,
				ConsumerName: tsConsumer,
				ProviderName: tsProvider,
				DDSite:       tsDDSite,
			})
		}
		fmt.Println("[idp] Backstage not reachable — falling back to local generation")
	}

	return scaffold.LocalTestSuite(cfg)
}
