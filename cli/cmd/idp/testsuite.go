package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/YOUR_GITHUB_ORG/backstage-idp-starter/cli/internal/backstage"
	"github.com/YOUR_GITHUB_ORG/backstage-idp-starter/cli/internal/scaffold"
	"github.com/spf13/cobra"
)

// templateRef maps CLI type names to Backstage template IDs.
var templateRef = map[string]string{
	"playwright":          "playwright-e2e-suite",
	"k6":                  "k6-performance-suite",
	"pact":                "pact-contract-suite",
	"newman":              "newman-api-suite",
	"zap":                 "zap-dast-suite",
	"datadog":             "datadog-synthetic-suite",
	"visual":              "visual-regression-suite",
	"accessibility":       "accessibility-suite",
	"cucumber":            "bdd-cucumber-suite",
	"appium":              "appium-mobile-suite",
	"chaos":               "chaos-mesh-suite",
	"mutation":            "mutation-testing-suite",
	"testcontainers":      "testcontainers-suite",
	"unit":                "unit-test-suite",
	"component":           "component-test-suite",
	"iac":                 "iac-test-suite",
	"flutter-integration": "flutter-integration-test-suite",
	"deepeval":            "deepeval-llm-eval-suite",
	"contract":            "enable-contract-testing",
	"security":            "enable-security-scanning",
}

// supportedTypes lists templateRef keys in help-text order.
const supportedTypes = "playwright k6 pact newman zap datadog visual accessibility cucumber appium chaos mutation testcontainers unit component iac flutter-integration deepeval contract security"

var (
	tsName      string
	tsType      string
	tsService   string
	tsNamespace string
	tsOwner     string
	tsDesc      string
	tsLocal     bool
	tsDryRun    bool
	tsURL       string
	tsTarget    string
	tsTargetURL string
	tsSet       []string

	// unit
	tsLanguage string
	tsCoverage int

	// deepeval
	tsAgentPrompt string
	tsAgentTools  string
	tsTargetAgent string

	// k6
	tsVUs          int
	tsDuration     string
	tsP95Threshold int

	// pact
	tsConsumer  string
	tsProvider  string
	tsBrokerURL string

	// zap
	tsScanType   string
	tsOpenAPIURL string
	tsFailRisk   string

	// datadog
	tsDDSite string

	// visual
	tsDiffThreshold string

	// playwright + visual
	tsCloudGrid string

	// accessibility
	tsWCAGLevel string

	// appium
	tsPlatform     string
	tsAppiumServer string
	tsDeviceFarm   string

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

Supported types:
  playwright | k6 | pact | newman | zap | datadog | visual |
  accessibility | cucumber | appium | chaos | mutation | testcontainers |
  unit | component | iac | flutter-integration | deepeval | contract | security

Greenfield vs brownfield:
  By default the suite goes into a NEW GitHub repo named --name.
  Pass --target-repo owner/repo to open a PR against an EXISTING repo instead.

  'unit', 'component', 'iac', 'flutter-integration' and 'security' are
  brownfield-only: they require --target-repo. 'deepeval' and 'contract'
  need Backstage but create a new repo. None of these seven have a local
  generator, so they can't be used with --local.

Any other template parameter can be passed with --set key=value
(see 'idp template params <template>').`,
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

  # Brownfield: add Playwright tests to an existing repo (opens a PR)
  idp scaffold test-suite --name hello-e2e --type playwright --service hello-service \
    --target-repo my-org/hello-service

  # Brownfield-only: unit-test scaffolding for a Go service
  idp scaffold test-suite --name hello-unit --type unit --service hello-service \
    --target-repo my-org/hello-service --language go

  # SAST/SCA (SonarCloud + Snyk) for an existing repo
  idp scaffold test-suite --name hello-sec-scan --type security --service hello-service \
    --target-repo my-org/hello-service

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
	f.BoolVar(&tsDryRun, "dry-run", false, "Print files that would be generated without writing them")
	f.StringVar(&tsURL, "backstage-url", "", "Backstage base URL (auto-resolved from IDP_BACKSTAGE_URL / IDP_DOMAIN when --env aws)")
	f.StringVar(&tsTarget, "target-repo", "", "Existing repo to open a PR against (owner/repo or GitHub URL) — brownfield mode")
	f.StringVar(&tsTargetURL, "target-url", "", "URL of the running service under test (k6/zap/datadog/playwright/newman/visual/accessibility/cucumber)")
	f.StringArrayVar(&tsSet, "set", nil, "Extra template parameter as key=value (repeatable)")

	// unit
	f.StringVar(&tsLanguage, "language", "", "unit: service language (go|nodejs|python) — required for --type unit")
	f.IntVar(&tsCoverage, "coverage", 70, "unit: minimum line coverage percentage")

	// deepeval
	f.StringVar(&tsAgentPrompt, "agent-prompt", "", "deepeval: system prompt of the agent under test (required for --type deepeval)")
	f.StringVar(&tsAgentTools, "agent-tools", "", "deepeval: comma-separated tool names the agent may call (required for --type deepeval)")
	f.StringVar(&tsTargetAgent, "target-agent", "", "deepeval: KAgent agent name under test")

	// k6
	f.IntVar(&tsVUs, "vus", 10, "k6: number of virtual users")
	f.StringVar(&tsDuration, "duration", "30s", "k6: load test duration (e.g. 1m, 5m)")
	f.IntVar(&tsP95Threshold, "p95", 500, "k6: p95 latency threshold in ms")

	// pact
	f.StringVar(&tsConsumer, "consumer", "", "pact/contract: consumer name (default: <name>-consumer)")
	f.StringVar(&tsProvider, "provider", "", "pact/contract: provider name (default: <service>)")
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
	f.StringVar(&tsDeviceFarm, "device-farm", "local-emulator", "appium: device farm (local-emulator|browserstack|sauce-labs|lambdatest)")
	f.StringVar(&tsCloudGrid, "cloud-grid", "none", "playwright/visual: cloud browser grid (none|lambdatest|browserstack|sauce-labs)")

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
		return fmt.Errorf("unknown --type %q; supported: %s", tsType, supportedTypes)
	}
	if err := validateTestSuiteMode(); err != nil {
		return err
	}
	extra, err := testSuiteExtras(cmd)
	if err != nil {
		return err
	}
	// Catch a bad --device-farm here rather than emitting a wdio.config.ts that
	// points at a hub that does not exist and only fails in CI.
	if tsType == "appium" {
		switch tsDeviceFarm {
		case "local-emulator", "browserstack", "sauce-labs", "lambdatest":
		default:
			return fmt.Errorf("unknown --device-farm %q; supported: local-emulator browserstack sauce-labs lambdatest", tsDeviceFarm)
		}
	}
	// Same reasoning for the web grid: a bad value would otherwise produce a
	// playwright.config.ts with no connectOptions and a CI job that silently
	// runs on the runner instead of the grid the user asked for.
	if tsType == "playwright" || tsType == "visual" {
		switch tsCloudGrid {
		case "none", "lambdatest", "browserstack", "sauce-labs":
		default:
			return fmt.Errorf("unknown --cloud-grid %q; supported: none lambdatest browserstack sauce-labs", tsCloudGrid)
		}
	}

	cfg := scaffold.TestSuiteConfig{
		Name:          tsName,
		Type:          tsType,
		Service:       tsService,
		Namespace:     tsNamespace,
		RootDir:       rootDir(),
		BaseURL:       firstNonEmpty(tsTargetURL, "http://localhost:3000"),
		TargetURL:     firstNonEmpty(tsTargetURL, "http://localhost:8080"),
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
		DeviceFarm:    tsDeviceFarm,
		CloudGrid:     tsCloudGrid,
		Experiments:   tsExperiments,
		ChaosDuration: tsChaosDuration,
		MutationScore: tsMutationScore,
		TestRunner:    tsTestRunner,
		Containers:    tsContainers,
		DryRun:        tsDryRun,
	}

	if tsDryRun && needsBackstage(tsType) {
		return previewValues(templateRef[tsType], backstage.TestSuiteValues(buildTestSuiteRequest(extra)))
	}

	if !tsLocal && !tsDryRun {
		url := resolveBackstageURL(scaffoldEnv, tsURL, rootDir())
		token := resolveToken(scaffoldEnv, scaffoldToken, rootDir())
		if scaffoldEnv == envAWS {
			fmt.Printf("[idp] Environment: aws — Backstage at %s\n", url)
		}
		client := backstage.NewClient(url, token)
		if client.Healthy(cmd.Context()) {
			fmt.Printf("[idp] Backstage reachable at %s — using Scaffolder API\n", url)
			return client.ScaffoldTestSuite(cmd.Context(), buildTestSuiteRequest(extra))
		}
		if needsBackstage(tsType) {
			return fmt.Errorf("Backstage is not reachable at %s; --type %s has no local generator", url, tsType)
		}
		fmt.Println("[idp] Backstage not reachable — falling back to local generation")
	}

	return scaffold.LocalTestSuite(cfg)
}

// needsBackstage reports whether the type can only be scaffolded through the
// Backstage API: brownfield mode, PR-only types, and types without a local generator.
func needsBackstage(t string) bool {
	return tsTarget != "" || scaffold.APIOnlyTypes[t]
}

// validateTestSuiteMode checks the greenfield/brownfield flags before any network call.
func validateTestSuiteMode() error {
	if tsTarget != "" {
		owner, repo, err := parseRepo(tsTarget)
		if err != nil {
			return err
		}
		tsTarget = owner + "/" + repo
		if tsLocal {
			return fmt.Errorf("--target-repo opens a PR through Backstage and can't be combined with --local")
		}
		if tsType == "contract" {
			return fmt.Errorf("--type contract deploys the contract MCP server and creates a new test repo; it doesn't take --target-repo")
		}
	}
	if scaffold.PROnlyTypes[tsType] && tsTarget == "" {
		return fmt.Errorf("--type %s opens a PR against an existing repo; pass --target-repo owner/repo", tsType)
	}
	if tsLocal && scaffold.APIOnlyTypes[tsType] {
		return fmt.Errorf("--type %s requires Backstage (no local generator); remove --local", tsType)
	}
	switch tsType {
	case "unit":
		switch tsLanguage {
		case "go", "nodejs", "python":
		default:
			return fmt.Errorf("--type unit needs --language go|nodejs|python (got %q)", tsLanguage)
		}
	case "deepeval":
		if tsAgentPrompt == "" || tsAgentTools == "" {
			return fmt.Errorf("--type deepeval needs --agent-prompt and --agent-tools")
		}
	}
	return nil
}

// testSuiteExtras maps type-specific flags to template parameter names.
// Flags are forwarded only when the user set them; otherwise RunTemplate
// fills in the template's declared default (the CLI defaults exist for
// local generation and don't always match the template's).
func testSuiteExtras(cmd *cobra.Command) (map[string]any, error) {
	changed := cmd.Flags().Changed
	extra := map[string]any{}
	set := func(flag, key string, v any) {
		if changed(flag) {
			extra[key] = v
		}
	}
	set("target-url", "targetUrl", tsTargetURL)
	set("target-url", "baseUrl", tsTargetURL)

	switch tsType {
	case "k6":
		set("vus", "vus", tsVUs)
		set("duration", "duration", tsDuration)
		set("p95", "p95Threshold", tsP95Threshold)
	case "pact":
		set("broker-url", "pactBrokerUrl", tsBrokerURL)
		set("target-url", "providerBaseUrl", tsTargetURL)
	case "zap":
		set("scan-type", "scanType", tsScanType)
		set("openapi-url", "openApiUrl", tsOpenAPIURL)
		set("fail-risk", "failOnRiskLevel", tsFailRisk)
	case "visual":
		if changed("threshold") {
			f, err := strconv.ParseFloat(tsDiffThreshold, 64)
			if err != nil {
				return nil, fmt.Errorf("--threshold must be a number (got %q)", tsDiffThreshold)
			}
			extra["diffThreshold"] = f
		}
	case "accessibility":
		set("wcag", "wcagLevel", tsWCAGLevel)
	case "appium":
		set("platform", "platform", tsPlatform)
		set("appium-server", "appiumServer", tsAppiumServer)
	case "chaos":
		set("experiments", "experiments", splitList(tsExperiments))
		set("chaos-duration", "duration", tsChaosDuration)
		set("namespace", "namespace", tsNamespace)
	case "mutation":
		set("score", "mutationScore", tsMutationScore)
		set("test-runner", "testRunner", tsTestRunner)
	case "testcontainers":
		set("containers", "containers", splitList(tsContainers))
		set("test-runner", "testRunner", tsTestRunner)
	case "unit":
		extra["language"] = tsLanguage
		set("coverage", "coverageThreshold", tsCoverage)
	case "deepeval":
		extra["agentSystemPrompt"] = tsAgentPrompt
		extra["agentTools"] = tsAgentTools
		set("target-agent", "targetAgent", tsTargetAgent)
	case "contract":
		extra["createTestRepo"] = true
		set("namespace", "targetNamespace", tsNamespace)
	}

	sets, err := parseSets(tsSet)
	if err != nil {
		return nil, err
	}
	for k, v := range sets {
		extra[k] = v
	}
	return extra, nil
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// buildTestSuiteRequest assembles the Backstage request from the parsed flags.
func buildTestSuiteRequest(extra map[string]any) backstage.TestSuiteRequest {
	desc := tsDesc
	if desc == "" {
		desc = tsType + " test suite for " + tsService
	}
	req := backstage.TestSuiteRequest{
		Name:         tsName,
		TemplateRef:  templateRef[tsType],
		Service:      tsService,
		Namespace:    tsNamespace,
		GHOrg:        ghOrg(),
		Owner:        tsOwner,
		Desc:         desc,
		TargetRepo:   tsTarget,
		ConsumerName: tsConsumer,
		ProviderName: tsProvider,
		Extra:        extra,
	}
	switch tsType {
	case "datadog":
		req.DDSite = tsDDSite
	case "appium":
		req.DeviceFarm = tsDeviceFarm
	case "playwright", "visual":
		req.CloudGrid = tsCloudGrid
	}
	if tsType == "pact" || tsType == "contract" {
		// Pact and contract templates require both names; mirror the local defaults.
		if req.ConsumerName == "" {
			req.ConsumerName = tsName + "-consumer"
		}
		if req.ProviderName == "" {
			req.ProviderName = tsService
		}
	}
	return req
}
