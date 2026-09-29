package main

// Drift guard between the CLI and the Backstage templates it drives. It reads
// the real template.yaml files, so a renamed or newly-required parameter
// fails here instead of as a 400 from the scaffolder at run time.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/YOUR_GITHUB_ORG/backstage-idp-starter/cli/internal/backstage"
	"github.com/YOUR_GITHUB_ORG/backstage-idp-starter/cli/internal/scaffold"
	"github.com/spf13/pflag"
)

var repoRoot = filepath.Join("..", "..", "..")

// typeFlags are the type-specific flags each test-suite type forwards.
// Every one is set in the parity run so its template key gets checked.
var typeFlags = map[string][]string{
	"playwright":     {"target-url"},
	"k6":             {"vus", "duration", "p95", "target-url"},
	"pact":           {"broker-url", "target-url"},
	"newman":         {"target-url"},
	"zap":            {"scan-type", "openapi-url", "fail-risk", "target-url"},
	"datadog":        {"target-url"},
	"visual":         {"threshold", "target-url"},
	"accessibility":  {"wcag", "target-url"},
	"cucumber":       {"target-url"},
	"appium":         {"platform", "appium-server"},
	"chaos":          {"experiments", "chaos-duration", "namespace"},
	"mutation":       {"score", "test-runner"},
	"testcontainers": {"containers", "test-runner"},
	"unit":           {"coverage"},
	"deepeval":       {"target-agent"},
	"contract":       {"namespace"},
}

// urlKeys: --target-url is sent under every name a template might use for it;
// only one has to be declared.
var urlKeys = map[string]bool{"targetUrl": true, "baseUrl": true, "providerBaseUrl": true}

// intentionallyUnmapped are *-suite templates with no `scaffold test-suite` type.
var intentionallyUnmapped = map[string]string{
	"contract-testing-suite": "legacy — superseded by enable-contract-testing (--type contract)",
}

func resetTestSuiteFlags(t *testing.T) {
	t.Helper()
	testSuiteCmd.Flags().VisitAll(func(f *pflag.Flag) {
		if sv, ok := f.Value.(pflag.SliceValue); ok {
			_ = sv.Replace(nil)
		} else if err := f.Value.Set(f.DefValue); err != nil {
			t.Fatalf("resetting --%s: %v", f.Name, err)
		}
		f.Changed = false
	})
}

func setFlag(t *testing.T, name, value string) {
	t.Helper()
	if err := testSuiteCmd.Flags().Set(name, value); err != nil {
		t.Fatalf("--%s=%s: %v", name, value, err)
	}
}

func loadSchema(t *testing.T, ref string) *backstage.TemplateSchema {
	t.Helper()
	s, err := localTemplateSchema(repoRoot, ref)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// checkValues asserts the values satisfy the template once filtered: nothing
// required is missing, types convert, and enum values are allowed.
func checkValues(t *testing.T, schema *backstage.TemplateSchema, values map[string]any) {
	t.Helper()
	kept, _ := schema.Filter(values)
	if err := schema.Coerce(kept); err != nil {
		t.Error(err)
	}
	if missing := schema.Missing(kept); len(missing) > 0 {
		t.Errorf("missing required parameter(s): %s", strings.Join(missing, ", "))
	}
	for k, v := range kept {
		enum := schema.Props[k].Enum
		if len(enum) == 0 {
			continue
		}
		ok := false
		for _, e := range enum {
			ok = ok || fmt.Sprint(e) == fmt.Sprint(v)
		}
		if !ok {
			t.Errorf("%s=%v is not one of %v", k, v, enum)
		}
	}
}

func TestTestSuiteTypesMatchTemplates(t *testing.T) {
	t.Setenv("GITHUB_ORG", "parity-org")
	t.Cleanup(func() { resetTestSuiteFlags(t) })

	for typ, ref := range templateRef {
		t.Run(typ, func(t *testing.T) {
			schema := loadSchema(t, ref)

			for _, mode := range []string{"greenfield", "brownfield"} {
				resetTestSuiteFlags(t)
				setFlag(t, "type", typ)
				setFlag(t, "name", "parity-demo")
				setFlag(t, "service", "hello-service")
				setFlag(t, "language", "go")
				setFlag(t, "agent-prompt", "You are a test agent.")
				setFlag(t, "agent-tools", "catalog_search")
				for _, fl := range typeFlags[typ] {
					v := testSuiteCmd.Flags().Lookup(fl).DefValue
					if v == "" {
						v = "http://hello-service.idp.local"
					}
					setFlag(t, fl, v)
				}
				if mode == "brownfield" {
					setFlag(t, "target-repo", "parity-org/hello-service")
				}

				err := validateTestSuiteMode()
				switch {
				case mode == "greenfield" && scaffold.PROnlyTypes[typ]:
					if err == nil {
						t.Error("PR-only type must reject greenfield (no --target-repo)")
					}
					continue
				case mode == "brownfield" && !schema.Declared("targetRepoUrl"):
					if err == nil {
						t.Error("template has no targetRepoUrl, so --target-repo must be rejected")
					}
					continue
				case err != nil:
					t.Fatalf("%s: %v", mode, err)
				}

				extra, err := testSuiteExtras(testSuiteCmd)
				if err != nil {
					t.Fatal(err)
				}
				urlDeclared := false
				for k := range extra {
					if urlKeys[k] {
						urlDeclared = urlDeclared || schema.Declared(k)
						continue
					}
					if !schema.Declared(k) {
						t.Errorf("%s: CLI sends %q but %s doesn't declare it", mode, k, ref)
					}
				}
				if _, sent := extra["targetUrl"]; sent && !urlDeclared {
					t.Errorf("--target-url is listed for %s but %s has no URL parameter", typ, ref)
				}
				t.Run(mode, func(t *testing.T) {
					checkValues(t, schema, backstage.TestSuiteValues(buildTestSuiteRequest(extra)))
				})
			}
		})
	}
}

func TestEverySuiteTemplateIsReachable(t *testing.T) {
	mapped := map[string]bool{}
	for _, ref := range templateRef {
		mapped[ref] = true
	}
	dirs, err := os.ReadDir(filepath.Join(repoRoot, "backstage", "catalog", "templates"))
	if err != nil {
		t.Fatal(err)
	}
	var missing []string
	for _, d := range dirs {
		name := d.Name()
		if d.IsDir() && strings.HasSuffix(name, "-suite") && !mapped[name] && intentionallyUnmapped[name] == "" {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("test-suite templates with no `idp scaffold test-suite --type`: %v\n"+
			"add them to templateRef in testsuite.go (and scaffold.APIOnlyTypes if they have no local generator), "+
			"or to intentionallyUnmapped with a reason", missing)
	}
	for ref := range intentionallyUnmapped {
		if mapped[ref] {
			t.Errorf("%s is both mapped and listed as intentionally unmapped", ref)
		}
	}
}

func TestAPIOnlyTypesHaveNoLocalGenerator(t *testing.T) {
	for typ := range scaffold.PROnlyTypes {
		if !scaffold.APIOnlyTypes[typ] {
			t.Errorf("PR-only type %s must also be API-only", typ)
		}
	}
	for typ := range scaffold.APIOnlyTypes {
		if _, ok := templateRef[typ]; !ok {
			t.Errorf("API-only type %s has no templateRef entry", typ)
		}
	}
}

func TestServiceTypesMatchTemplates(t *testing.T) {
	for typ, ref := range serviceTemplateRef {
		t.Run(typ, func(t *testing.T) {
			schema := loadSchema(t, ref)
			for _, target := range []string{envLocal, envAWS} {
				values := backstage.ServiceValues(backstage.ScaffoldRequest{
					Name: "parity-svc", Owner: "group:default/platform-team", Desc: "parity",
					GHOrg: "parity-org", CostCenter: "eng-platform", DeployTarget: target,
					ClusterName: "idp-mvp", AWSRegion: "us-east-1",
				})
				if _, dropped := schema.Filter(values); len(dropped) > 0 {
					t.Errorf("%s: CLI sends undeclared parameter(s) %v", target, dropped)
				}
				checkValues(t, schema, values)
			}
		})
	}
	for typ := range localServiceTypes {
		if _, err := os.Stat(filepath.Join("..", "..", "internal", "scaffold", "templates", typ)); err != nil {
			t.Errorf("local service type %s has no generator directory: %v", typ, err)
		}
	}
}
