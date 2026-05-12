package scaffold

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

// TestSuiteConfig holds all parameters for scaffolding a test suite.
type TestSuiteConfig struct {
	Name      string
	Type      string
	Service   string
	Namespace string
	GHOrg     string
	BaseURL   string
	TargetURL string
	RootDir   string

	// k6
	VUs          int
	Duration     string
	P95Threshold int

	// pact
	ConsumerName  string
	ProviderName  string
	PactBrokerURL string

	// zap
	ScanType   string
	OpenAPIURL string
	FailRisk   string

	// datadog
	DDSite string

	// visual
	DiffThreshold string

	// accessibility
	WCAGLevel string

	// appium
	Platform     string
	AppiumServer string

	// chaos
	Experiments   string
	ChaosDuration string

	// mutation
	MutationScore int
	TestRunner    string

	// testcontainers
	Containers string
}

// LocalTestSuite generates a test suite scaffold under <RootDir>/test-suites/<Name>.
func LocalTestSuite(cfg TestSuiteConfig) error {
	cfg = applyTestSuiteDefaults(cfg)

	targetDir := filepath.Join(cfg.RootDir, "test-suites", cfg.Name)
	if _, err := os.Stat(targetDir); err == nil {
		return fmt.Errorf("test suite %q already exists at %s", cfg.Name, targetDir)
	}

	generators := map[string]func(TestSuiteConfig, string) error{
		"playwright":     genPlaywright,
		"k6":             genK6,
		"pact":           genPact,
		"newman":         genNewman,
		"zap":            genZAP,
		"datadog":        genDatadog,
		"visual":         genVisual,
		"accessibility":  genAccessibility,
		"cucumber":       genCucumber,
		"appium":         genAppium,
		"chaos":          genChaos,
		"mutation":       genMutation,
		"testcontainers": genTestcontainers,
	}

	gen, ok := generators[cfg.Type]
	if !ok {
		return fmt.Errorf("unknown test suite type: %s", cfg.Type)
	}
	cleanup := func(err error) error {
		_ = os.RemoveAll(targetDir)
		return err
	}

	if err := gen(cfg, targetDir); err != nil {
		return cleanup(err)
	}

	// Always write shared files (catalog-info, mkdocs).
	if err := writeTSFile(targetDir, "catalog-info.yaml", tsCatalogInfo, cfg); err != nil {
		return cleanup(err)
	}
	if err := writeTSFile(targetDir, "mkdocs.yml", tsMkdocs, cfg); err != nil {
		return cleanup(err)
	}
	if err := os.MkdirAll(filepath.Join(targetDir, "docs"), 0o755); err != nil {
		return cleanup(err)
	}

	if err := gitCommit(cfg.RootDir, "test-suites/"+cfg.Name); err != nil {
		fmt.Printf("[idp] Warning: git commit/push skipped: %v\n", err)
	}

	fmt.Printf("[idp] Test suite %q (%s) scaffolded at %s\n", cfg.Name, cfg.Type, targetDir)
	fmt.Printf("[idp] Next: cd test-suites/%s\n", cfg.Name)
	return nil
}

func applyTestSuiteDefaults(cfg TestSuiteConfig) TestSuiteConfig {
	if cfg.GHOrg == "" {
		cfg.GHOrg = firstNonEmpty(
			os.Getenv("GITHUB_ORG"),
			os.Getenv("GH_ORG"),
			envOrFromFile(cfg.RootDir+"/local/.env", "GITHUB_ORG"),
			"YOUR_GITHUB_ORG",
		)
	}
	if cfg.ConsumerName == "" {
		cfg.ConsumerName = cfg.Name + "-consumer"
	}
	if cfg.ProviderName == "" {
		cfg.ProviderName = cfg.Service
	}
	return cfg
}

// writeTSFile renders a template string and writes it to outPath inside targetDir.
func writeTSFile(targetDir, relPath, tmplStr string, data TestSuiteConfig) error {
	outPath := filepath.Join(targetDir, relPath)
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return err
	}
	t, err := template.New(relPath).Delims("<%", "%>").Parse(tmplStr)
	if err != nil {
		return fmt.Errorf("parse template %s: %w", relPath, err)
	}
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return t.Execute(f, data)
}

// ── Shared templates ──────────────────────────────────────────────────────────

const tsCatalogInfo = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: <% .Name %>
  description: <% .Type %> test suite for <% .Service %>
  annotations:
    github.com/project-slug: <% .GHOrg %>/<% .Name %>
    backstage.io/techdocs-ref: dir:.
spec:
  type: test-suite
  lifecycle: production
  owner: qa-team
  system: internal-developer-platform
  dependsOn:
    - component:default/<% .Service %>
`

const tsMkdocs = `site_name: <% .Name %>
site_description: <% .Type %> test suite for <% .Service %>

nav:
  - Home: index.md

plugins:
  - techdocs-core
`

// ── Playwright ────────────────────────────────────────────────────────────────

func genPlaywright(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "playwright test",
    "test:update": "playwright test --update-snapshots"
  },
  "devDependencies": {
    "@playwright/test": "^1.44.0",
    "typescript": "^5.4.0"
  }
}
`,
		"tsconfig.json": `{ "compilerOptions": { "target": "ES2022", "module": "commonjs", "strict": true, "esModuleInterop": true, "skipLibCheck": true } }
`,
		"playwright.config.ts": `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['github']],
  use: {
    baseURL: process.env.BASE_URL ?? '<% .BaseURL %>',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
		"tests/fixtures/base.fixture.ts": `import { test as base, expect } from '@playwright/test';
export const test = base.extend({});
export { expect };
`,
		"tests/example.spec.ts": `import { test, expect } from './fixtures/base.fixture';

test.describe('<% .Service %> smoke', () => {
  test('homepage loads', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/.+/);
  });

  test('health endpoint returns 200', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
  });
});
`,
		"README.md": `# <% .Name %>

Playwright E2E suite for ` + "`<% .Service %>`" + `.

` + "```" + `bash
npm install && npx playwright install --with-deps
npm test
npx playwright show-report
BASE_URL=http://staging.example.com npm test   # override target
` + "```" + `
`,
		"docs/index.md": `# <% .Name %>

Playwright E2E suite targeting **<% .Service %>** at ` + "`<% .BaseURL %>`" + `.

Run ` + "`npm test`" + ` locally, or push to trigger GitHub Actions CI.
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── k6 ────────────────────────────────────────────────────────────────────────

func genK6(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"tests/smoke.js": `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1, duration: '30s',
  thresholds: { http_req_duration: ['p(95)<<% .P95Threshold %>'], http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || '<% .TargetURL %>';
export default function () {
  const r = http.get(` + "`${BASE}/healthz`" + `);
  check(r, { 'status 200': (res) => res.status === 200 });
  sleep(1);
}
`,
		"tests/load.js": `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: <% .VUs %> },
    { duration: '<% .Duration %>', target: <% .VUs %> },
    { duration: '30s', target: 0 },
  ],
  thresholds: { http_req_duration: ['p(95)<<% .P95Threshold %>'], http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || '<% .TargetURL %>';
export default function () {
  const r = http.get(` + "`${BASE}/`" + `);
  check(r, { 'status 2xx': (res) => res.status >= 200 && res.status < 300 });
  sleep(1);
}
`,
		"tests/stress.js": `import http from 'k6/http';
import { check, sleep } from 'k6';

const PEAK = <% .VUs %> * 3;
export const options = {
  stages: [
    { duration: '2m', target: <% .VUs %> }, { duration: '5m', target: <% .VUs %> },
    { duration: '2m', target: PEAK },       { duration: '5m', target: PEAK },
    { duration: '2m', target: 0 },
  ],
  thresholds: { http_req_duration: ['p(99)<2000'], http_req_failed: ['rate<0.05'] },
};

const BASE = __ENV.TARGET_URL || '<% .TargetURL %>';
export default function () {
  check(http.get(` + "`${BASE}/`" + `), { 'status 2xx': (r) => r.status >= 200 && r.status < 300 });
  sleep(1);
}
`,
		"README.md": `# <% .Name %>

k6 performance suite for ` + "`<% .Service %>`" + ` — <% .VUs %> VUs, <% .Duration %>, p95 < <% .P95Threshold %>ms.

` + "```" + `bash
k6 run tests/smoke.js
k6 run tests/load.js
k6 run tests/stress.js
k6 run -e TARGET_URL=http://staging.example.com tests/load.js
` + "```" + `
`,
		"docs/index.md": `# <% .Name %>

k6 performance suite for **<% .Service %>**.

| Parameter | Value |
|-----------|-------|
| Target URL | ` + "`<% .TargetURL %>`" + ` |
| Load VUs | <% .VUs %> |
| Duration | <% .Duration %> |
| p95 threshold | <% .P95Threshold %>ms |
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── Pact ──────────────────────────────────────────────────────────────────────

func genPact(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "jest --testPathPattern=consumer" },
  "devDependencies": {
    "@pact-foundation/pact": "^12.0.0",
    "@types/jest": "^29.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "typescript": "^5.4.0"
  }
}
`,
		"tests/consumer.pact.spec.ts": `import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';

const { like } = MatchersV3;

const provider = new PactV3({
  consumer: '<% .ConsumerName %>',
  provider: '<% .ProviderName %>',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('<% .ConsumerName %> → <% .ProviderName %>', () => {
  it('health endpoint responds', async () => {
    await provider
      .given('provider is healthy')
      .uponReceiving('a health check')
      .withRequest({ method: 'GET', path: '/healthz' })
      .willRespondWith({ status: 200, body: like({ status: 'ok' }) })
      .executeTest(async (mock) => {
        const res = await fetch(` + "`${mock.url}/healthz`" + `);
        expect(res.status).toBe(200);
      });
  });
});
`,
		"README.md": `# <% .Name %>

Pact contract tests: **<% .ConsumerName %>** → **<% .ProviderName %>**.

` + "```" + `bash
npm install
npm test                    # generate pacts/
PROVIDER_BASE_URL=<% .TargetURL %> npm run verify
` + "```" + `

Set ` + "`PACT_BROKER_TOKEN`" + ` secret to publish to ` + "`<% .PactBrokerURL %>`" + `.
`,
		"docs/index.md": `# <% .Name %>

Pact consumer-driven contracts for **<% .Service %>**.

| Parameter | Value |
|-----------|-------|
| Consumer | ` + "`<% .ConsumerName %>`" + ` |
| Provider | ` + "`<% .ProviderName %>`" + ` |
| Broker | ` + "`<% .PactBrokerURL %>`" + ` |
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── Newman ────────────────────────────────────────────────────────────────────

func genNewman(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "newman run collections/<% .Name %>.postman_collection.json -e environments/dev.json --reporters cli,junit --reporter-junit-export reports/results.xml"
  },
  "devDependencies": {
    "newman": "^6.1.0",
    "newman-reporter-htmlextra": "^1.23.0"
  }
}
`,
		"environments/dev.json": `{
  "name": "<% .Name %>-dev",
  "values": [{ "key": "baseUrl", "value": "<% .BaseURL %>", "type": "default", "enabled": true }]
}
`,
		"collections/<% .Name %>.postman_collection.json": `{
  "info": { "name": "<% .Name %>", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  "item": [{
    "name": "Health Check",
    "item": [
      {
        "name": "GET /healthz",
        "request": { "method": "GET", "url": "{{baseUrl}}/healthz" },
        "event": [{ "listen": "test", "script": { "exec": ["pm.test('Status 200', () => pm.response.to.have.status(200));"], "type": "text/javascript" } }]
      }
    ]
  }]
}
`,
		"README.md": `# <% .Name %>

Newman API test suite for ` + "`<% .Service %>`" + ` at ` + "`<% .BaseURL %>`" + `.

` + "```" + `bash
npm install && npm test
` + "```" + `

Import ` + "`collections/<% .Name %>.postman_collection.json`" + ` into Postman to edit visually.
`,
		"docs/index.md": `# <% .Name %>

Newman API suite targeting **<% .Service %>** at ` + "`<% .BaseURL %>`" + `.
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── ZAP ───────────────────────────────────────────────────────────────────────

func genZAP(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		".zap/rules.tsv": `# ZAP false-positive suppression
# Format: <ruleId>\t<action>\t<url>\t<parameter>\t<attack>\t<evidence>\t<comment>
# Example: 10021\tIGNORE\t.*\t.*\t.*\t.*\tKnown false positive
`,
		"README.md": `# <% .Name %>

OWASP ZAP ` + "`<% .ScanType %>`" + ` DAST scan for ` + "`<% .Service %>`" + ` at ` + "`<% .TargetURL %>`" + `.

` + "```" + `bash
# Requires Docker
docker run --rm -v $(pwd)/reports:/zap/wrk:rw \
  ghcr.io/zaproxy/zaproxy:stable zap-<% .ScanType %>.py \
  -t <% .TargetURL %> -r zap-report.html
` + "```" + `

Suppress false positives in ` + "`.zap/rules.tsv`" + `.
`,
		"docs/index.md": `# <% .Name %>

OWASP ZAP security scan for **<% .Service %>**.

| Parameter | Value |
|-----------|-------|
| Scan type | ` + "`<% .ScanType %>`" + ` |
| Target URL | ` + "`<% .TargetURL %>`" + ` |
| OpenAPI URL | ` + "`<% .OpenAPIURL %>`" + ` |
| Fail on | ` + "`<% .FailRisk %>`" + ` risk and above |
`,
	}
	// Ensure reports dir exists
	_ = os.MkdirAll(filepath.Join(dir, "reports"), 0o755)
	return writeTSFiles(dir, files, cfg)
}

// ── Datadog ───────────────────────────────────────────────────────────────────

func genDatadog(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "datadog-ci synthetics run-tests --config datadog-ci.json" },
  "devDependencies": { "@datadog/datadog-ci": "^2.18.0" }
}
`,
		"datadog-ci.json": `{
  "datadogSite": "<% .DDSite %>",
  "files": ["synthetics/**/*.json"],
  "failOnCriticalErrors": true,
  "failOnMissingTests": true,
  "runName": "<% .Name %> - CI run"
}
`,
		"synthetics/api-test.json": `{
  "name": "<% .Name %> - API health check",
  "type": "api", "subtype": "http", "status": "live",
  "tags": ["service:<% .Name %>", "env:production"],
  "locations": ["aws:eu-west-1", "aws:us-east-1"],
  "options": { "tick_every": 300, "retry": { "count": 2, "interval": 300 } },
  "config": {
    "request": { "method": "GET", "url": "<% .TargetURL %>/healthz", "timeout": 30 },
    "assertions": [
      { "type": "statusCode", "operator": "is", "target": 200 },
      { "type": "responseTime", "operator": "lessThan", "target": 2000 }
    ]
  }
}
`,
		"README.md": `# <% .Name %>

Datadog synthetic tests for ` + "`<% .Service %>`" + ` on ` + "`<% .DDSite %>`" + `.

` + "```" + `bash
npm install
DD_API_KEY=<key> DD_APP_KEY=<app_key> npm test
` + "```" + `

Set ` + "`DD_API_KEY`" + ` and ` + "`DD_APP_KEY`" + ` as GitHub repository secrets.
`,
		"docs/index.md": `# <% .Name %>

Datadog synthetic monitoring for **<% .Service %>**.

| Parameter | Value |
|-----------|-------|
| Datadog site | ` + "`<% .DDSite %>`" + ` |
| Target URL | ` + "`<% .TargetURL %>`" + ` |
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── Visual Regression ─────────────────────────────────────────────────────────

func genVisual(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "playwright test",
    "test:update": "playwright test --update-snapshots"
  },
  "devDependencies": {
    "@playwright/test": "^1.44.0",
    "typescript": "^5.4.0"
  }
}
`,
		"playwright.config.ts": `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? '<% .BaseURL %>',
    screenshot: 'on',
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: <% .DiffThreshold %> } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
		"tests/visual.spec.ts": `import { test, expect } from '@playwright/test';

test.describe('<% .Service %> visual snapshots', () => {
  test('homepage matches snapshot', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveScreenshot('homepage.png', { fullPage: true });
  });
});
`,
		"README.md": `# <% .Name %>

Visual regression suite for ` + "`<% .Service %>`" + `. Diff threshold: **<% .DiffThreshold %>**.

` + "```" + `bash
npm install && npx playwright install chromium
npm run test:update   # capture baseline snapshots
npm test              # compare against baseline
` + "```" + `

Commit ` + "`tests/__snapshots__/`" + ` as the golden baseline.
`,
		"docs/index.md": `# <% .Name %>

Visual regression suite for **<% .Service %>** at ` + "`<% .BaseURL %>`" + `.
Max pixel diff ratio: **<% .DiffThreshold %>**.
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── Accessibility ─────────────────────────────────────────────────────────────

func genAccessibility(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "playwright test" },
  "devDependencies": {
    "@axe-core/playwright": "^4.9.0",
    "@playwright/test": "^1.44.0",
    "typescript": "^5.4.0"
  }
}
`,
		"playwright.config.ts": `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  reporter: [['html', { open: 'never' }], ['github']],
  use: { baseURL: process.env.BASE_URL ?? '<% .BaseURL %>' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
		"tests/a11y.spec.ts": `import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('<% .Service %> accessibility (<% .WCAGLevel %>)', () => {
  test('homepage has no violations', async ({ page }) => {
    await page.goto('/');
    const results = await new AxeBuilder({ page })
      .withTags(['<% .WCAGLevel %>'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
`,
		"README.md": `# <% .Name %>

axe-core + Playwright accessibility suite for ` + "`<% .Service %>`" + `. Standard: **<% .WCAGLevel %>**.

` + "```" + `bash
npm install && npx playwright install chromium --with-deps
npm test
` + "```" + `
`,
		"docs/index.md": `# <% .Name %>

Accessibility suite for **<% .Service %>** enforcing **<% .WCAGLevel %>** at ` + "`<% .BaseURL %>`" + `.
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── Cucumber ──────────────────────────────────────────────────────────────────

func genCucumber(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "cucumber-js --config cucumber.js" },
  "devDependencies": {
    "@cucumber/cucumber": "^10.8.0",
    "axios": "^1.7.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0"
  }
}
`,
		"cucumber.js": `module.exports = {
  default: {
    require: ['steps/**/*.ts'],
    requireModule: ['ts-node/register'],
    format: ['progress-bar', 'junit:reports/junit.xml'],
    paths: ['features/**/*.feature'],
    publishQuiet: true,
  },
};
`,
		"features/health.feature": `Feature: <% .Service %> health

  Scenario: Liveness probe returns 200
    Given the service is running at "<% .BaseURL %>"
    When I request "/healthz"
    Then the response status should be 200

  Scenario: Readiness probe returns 200
    Given the service is running at "<% .BaseURL %>"
    When I request "/ready"
    Then the response status should be 200
`,
		"steps/health.steps.ts": `import { Given, When, Then } from '@cucumber/cucumber';
import axios from 'axios';
import assert from 'assert';

let baseUrl: string;
let response: { status: number };

Given('the service is running at {string}', (url: string) => {
  baseUrl = process.env.BASE_URL ?? url;
});

When('I request {string}', async (path: string) => {
  response = await axios.get(` + "`${baseUrl}${path}`" + `, { validateStatus: () => true });
});

Then('the response status should be {int}', (expected: number) => {
  assert.strictEqual(response.status, expected);
});
`,
		"README.md": `# <% .Name %>

Cucumber.js BDD suite for ` + "`<% .Service %>`" + `.

` + "```" + `bash
npm install
npm test
BASE_URL=http://staging.example.com npm test
` + "```" + `
`,
		"docs/index.md": `# <% .Name %>

Cucumber.js BDD suite for **<% .Service %>** at ` + "`<% .BaseURL %>`" + `.
Feature files are in ` + "`features/`" + `, step definitions in ` + "`steps/`" + `.
`,
	}
	_ = os.MkdirAll(filepath.Join(dir, "reports"), 0o755)
	return writeTSFiles(dir, files, cfg)
}

// ── Appium ────────────────────────────────────────────────────────────────────

func genAppium(cfg TestSuiteConfig, dir string) error {
	automationName := "UiAutomator2"
	deviceName := "Android Emulator"
	platformName := "Android"
	if strings.EqualFold(cfg.Platform, "ios") {
		automationName = "XCUITest"
		deviceName = "iPhone Simulator"
		platformName = "iOS"
	}

	type appiumData struct {
		TestSuiteConfig
		AutomationName string
		DeviceName     string
		PlatformName   string
	}
	data := appiumData{cfg, automationName, deviceName, platformName}

	// Render wdio.config.ts with extra fields.
	wdioCfg := `import type { Options } from '@wdio/types';
export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/**/*.spec.ts'],
  framework: 'mocha',
  reporters: ['spec', ['junit', { outputDir: './reports' }]],
  mochaOpts: { timeout: 60000 },
  capabilities: [{
    platformName: '<% .PlatformName %>',
    'appium:automationName': '<% .AutomationName %>',
    'appium:deviceName': '<% .DeviceName %>',
    'appium:app': process.env.APP_PATH ?? 'path/to/your.app',
  }],
  services: [['appium', { command: 'appium', args: { address: '127.0.0.1', port: 4723 } }]],
};
`
	_ = os.MkdirAll(filepath.Join(dir, "tests"), 0o755)
	_ = os.MkdirAll(filepath.Join(dir, "reports"), 0o755)

	if err := func() error {
		t, err := template.New("wdio").Delims("<%", "%>").Parse(wdioCfg)
		if err != nil {
			return err
		}
		f, err := os.Create(filepath.Join(dir, "wdio.config.ts"))
		if err != nil {
			return err
		}
		defer f.Close()
		return t.Execute(f, data)
	}(); err != nil {
		return err
	}

	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "wdio run wdio.config.ts" },
  "devDependencies": {
    "@wdio/cli": "^8.36.0",
    "@wdio/local-runner": "^8.36.0",
    "@wdio/mocha-framework": "^8.36.0",
    "@wdio/spec-reporter": "^8.36.0",
    "@wdio/junit-reporter": "^8.36.0",
    "appium": "^2.5.0",
    "appium-uiautomator2-driver": "^3.5.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0"
  }
}
`,
		"tests/app.spec.ts": `import { browser } from '@wdio/globals';

describe('<% .Service %> mobile smoke', () => {
  it('app launches', async () => {
    expect(await browser.getPageSource()).toBeTruthy();
  });
});
`,
		"README.md": `# <% .Name %>

Appium + WebdriverIO mobile tests for ` + "`<% .Service %>`" + ` on **<% .Platform %>**.

` + "```" + `bash
npm install
APP_PATH=/path/to/your.app npm test
` + "```" + `
`,
		"docs/index.md": `# <% .Name %>

Appium mobile test suite for **<% .Service %>** on **<% .Platform %>**.
Appium server: ` + "`<% .AppiumServer %>`" + `.
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── Chaos ─────────────────────────────────────────────────────────────────────

func genChaos(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"experiments/pod-failure.yaml": `apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: <% .Name %>-pod-failure
  namespace: <% .Namespace %>
spec:
  action: pod-failure
  mode: one
  duration: '<% .ChaosDuration %>'
  selector:
    namespaces: [<% .Namespace %>]
    labelSelectors:
      app.kubernetes.io/name: <% .Service %>
`,
		"experiments/network-latency.yaml": `apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: <% .Name %>-network-latency
  namespace: <% .Namespace %>
spec:
  action: delay
  mode: all
  duration: '<% .ChaosDuration %>'
  selector:
    namespaces: [<% .Namespace %>]
    labelSelectors:
      app.kubernetes.io/name: <% .Service %>
  delay:
    latency: '100ms'
    jitter: '20ms'
    correlation: '25'
`,
		"experiments/cpu-stress.yaml": `apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: <% .Name %>-cpu-stress
  namespace: <% .Namespace %>
spec:
  mode: one
  duration: '<% .ChaosDuration %>'
  selector:
    namespaces: [<% .Namespace %>]
    labelSelectors:
      app.kubernetes.io/name: <% .Service %>
  stressors:
    cpu: { workers: 2, load: 80 }
`,
		"experiments/memory-stress.yaml": `apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: <% .Name %>-memory-stress
  namespace: <% .Namespace %>
spec:
  mode: one
  duration: '<% .ChaosDuration %>'
  selector:
    namespaces: [<% .Namespace %>]
    labelSelectors:
      app.kubernetes.io/name: <% .Service %>
  stressors:
    memory: { workers: 1, size: '256MB' }
`,
		"README.md": `# <% .Name %>

Chaos Mesh experiments for ` + "`<% .Service %>`" + ` in namespace ` + "`<% .Namespace %>`" + `. Duration: **<% .ChaosDuration %>**.

` + "```" + `bash
kubectl apply -f experiments/pod-failure.yaml
# wait <% .ChaosDuration %>, then:
kubectl delete -f experiments/pod-failure.yaml
` + "```" + `
`,
		"docs/index.md": `# <% .Name %>

Chaos Mesh resilience experiments for **<% .Service %>** in ` + "`<% .Namespace %>`" + `.
Duration per experiment: **<% .ChaosDuration %>**.

| Experiment | Type |
|-----------|------|
| pod-failure | PodChaos |
| network-latency | NetworkChaos |
| cpu-stress | StressChaos |
| memory-stress | StressChaos |
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── Mutation ──────────────────────────────────────────────────────────────────

func genMutation(cfg TestSuiteConfig, dir string) error {
	breakScore := cfg.MutationScore - 20

	type mutData struct {
		TestSuiteConfig
		BreakScore int
	}
	data := mutData{cfg, breakScore}

	strykerCfg := `/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
module.exports = {
  packageManager: 'npm',
  testRunner: '<% .TestRunner %>',
  reporters: ['progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/report.json' },
  coverageAnalysis: 'perTest',
  thresholds: { high: <% .MutationScore %>, low: <%- sub .MutationScore 10 %>, break: <% .BreakScore %> },
};
`

	_ = os.MkdirAll(filepath.Join(dir, "reports/mutation"), 0o755)

	// Write stryker.config.js with custom sub function.
	if err := func() error {
		fmap := template.FuncMap{"sub": func(a, b int) int { return a - b }}
		t, err := template.New("stryker").Delims("<%", "%>").Funcs(fmap).Parse(strykerCfg)
		if err != nil {
			return err
		}
		f, err := os.Create(filepath.Join(dir, "stryker.config.js"))
		if err != nil {
			return err
		}
		defer f.Close()
		return t.Execute(f, data)
	}(); err != nil {
		return err
	}

	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "stryker run" },
  "devDependencies": {
    "@stryker-mutator/core": "^8.2.0",
    "@stryker-mutator/<% .TestRunner %>-runner": "^8.2.0",
    "typescript": "^5.4.0"
  }
}
`,
		"README.md": `# <% .Name %>

Stryker mutation testing for ` + "`<% .Service %>`" + `. Min score: **<% .MutationScore %>%**.

` + "```" + `bash
npm install && npm test
# HTML report: reports/mutation/index.html
` + "```" + `

Point ` + "`stryker.config.js`" + ` at the target service source and test files before running.
`,
		"docs/index.md": `# <% .Name %>

Stryker mutation testing for **<% .Service %>**.
Minimum score: **<% .MutationScore %>%**. Test runner: **<% .TestRunner %>**.
`,
	}
	return writeTSFiles(dir, files, cfg)
}

// ── Testcontainers ────────────────────────────────────────────────────────────

func genTestcontainers(cfg TestSuiteConfig, dir string) error {
	files := map[string]string{
		"package.json": `{
  "name": "<% .Name %>",
  "version": "0.1.0",
  "private": true,
  "scripts": { "test": "jest" },
  "devDependencies": {
    "@types/jest": "^29.0.0",
    "jest": "^29.0.0",
    "testcontainers": "^10.9.0",
    "ts-jest": "^29.0.0",
    "typescript": "^5.4.0"
  }
}
`,
		"jest.config.js": `module.exports = { preset: 'ts-jest', testEnvironment: 'node', testTimeout: 60000 };
`,
		"tests/integration.spec.ts": `import { GenericContainer, Wait } from 'testcontainers';

describe('<% .Service %> integration', () => {
  const stopped: Array<{ stop: () => Promise<void> }> = [];
  afterAll(async () => { await Promise.all(stopped.map((c) => c.stop())); });

  test('postgres container starts', async () => {
    const pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
      .withExposedPorts(5432)
      .start();
    stopped.push(pg);

    expect(pg.getMappedPort(5432)).toBeGreaterThan(0);
    // Add your service integration assertions here
  });
});
`,
		"README.md": `# <% .Name %>

Testcontainers integration tests for ` + "`<% .Service %>`" + `.
Containers: **<% .Containers %>**.

` + "```" + `bash
npm install
npm test   # Docker must be running
` + "```" + `
`,
		"docs/index.md": `# <% .Name %>

Testcontainers integration tests for **<% .Service %>**.
Real containers (<% .Containers %>) spin up in CI — no mocks.
`,
	}
	_ = os.MkdirAll(filepath.Join(dir, "reports"), 0o755)
	return writeTSFiles(dir, files, cfg)
}

// ── Helper ────────────────────────────────────────────────────────────────────

// writeTSFiles renders and writes each map entry. Keys ending in a template
// expression (e.g. "collections/<% .Name %>.json") are rendered as paths first.
func writeTSFiles(dir string, files map[string]string, cfg TestSuiteConfig) error {
	for relPath, content := range files {
		// Render the path itself (handles "collections/<% .Name %>.postman_collection.json").
		renderedPath, err := renderString(relPath, cfg)
		if err != nil {
			return fmt.Errorf("render path %s: %w", relPath, err)
		}
		if err := writeTSFile(dir, renderedPath, content, cfg); err != nil {
			return err
		}
	}
	return nil
}

func renderString(tmplStr string, data any) (string, error) {
	t, err := template.New("").Delims("<%", "%>").Parse(tmplStr)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	if err := t.Execute(&sb, data); err != nil {
		return "", err
	}
	return sb.String(), nil
}
