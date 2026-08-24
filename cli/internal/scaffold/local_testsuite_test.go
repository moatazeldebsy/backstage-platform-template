package scaffold

import (
	"os"
	"strings"
	"testing"
)

func TestGenAppiumDeviceFarm(t *testing.T) {
	cases := map[string]struct{ hostname, marker string }{
		"local-emulator": {"127.0.0.1", "services: [['appium'"},
		"browserstack":   {"hub-cloud.browserstack.com", "'bstack:options'"},
		"sauce-labs":     {"ondemand.us-west-1.saucelabs.com", "'sauce:options'"},
		"lambdatest":     {"mobile-hub.lambdatest.com", "'LT:Options'"},
	}
	for farm, want := range cases {
		t.Run(farm, func(t *testing.T) {
			dir := t.TempDir()
			cfg := TestSuiteConfig{Name: "demo", Service: "svc", Platform: "android", DeviceFarm: farm}
			if err := genAppium(cfg, dir); err != nil {
				t.Fatalf("genAppium: %v", err)
			}
			b, err := os.ReadFile(dir + "/wdio.config.ts")
			if err != nil {
				t.Fatal(err)
			}
			got := string(b)
			if !strings.Contains(got, "hostname: '"+want.hostname+"'") {
				t.Errorf("%s: missing hostname %q\n%s", farm, want.hostname, got)
			}
			if !strings.Contains(got, want.marker) {
				t.Errorf("%s: missing %q\n%s", farm, want.marker, got)
			}
			if farm != "local-emulator" && strings.Contains(got, "services: [['appium'") {
				t.Errorf("%s: cloud farm must not start a local Appium server", farm)
			}
		})
	}
}

func TestGenPlaywrightCloudGrid(t *testing.T) {
	cases := map[string]string{
		"none":         "",
		"lambdatest":   "cdp.lambdatest.com",
		"browserstack": "cdp.browserstack.com",
		// Sauce has no Playwright CDP endpoint — it runs via saucectl, so the
		// generated config must stay in its plain local-runner form.
		"sauce-labs": "",
	}
	for _, gen := range []struct {
		name string
		fn   func(TestSuiteConfig, string) error
	}{{"playwright", genPlaywright}, {"visual", genVisual}} {
		for grid, want := range cases {
			t.Run(gen.name+"/"+grid, func(t *testing.T) {
				dir := t.TempDir()
				cfg := TestSuiteConfig{Name: "demo", Service: "svc", BaseURL: "https://x.test", CloudGrid: grid}
				if err := gen.fn(cfg, dir); err != nil {
					t.Fatalf("%s: %v", gen.name, err)
				}
				b, err := os.ReadFile(dir + "/playwright.config.ts")
				if err != nil {
					t.Fatal(err)
				}
				got := string(b)
				if want == "" {
					if strings.Contains(got, "connectOptions") {
						t.Errorf("%s/%s: expected no connectOptions\n%s", gen.name, grid, got)
					}
					return
				}
				if !strings.Contains(got, want) {
					t.Errorf("%s/%s: missing %q\n%s", gen.name, grid, want, got)
				}
				if !strings.Contains(got, "connectOptions") {
					t.Errorf("%s/%s: missing connectOptions", gen.name, grid)
				}
			})
		}
	}
}
