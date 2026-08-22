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
