package main

import "testing"

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.21.0", "1.21.0", 0},
		{"1.22.0", "1.21.0", 1},
		{"1.20.0", "1.21.0", -1},
		{"18.19.1", "18.0.0", 1},
		{"3.9", "3.12.0", -1},
		{"3.12.1", "3.12.0", 1},

		// A major bump must beat a two-digit minor: Helm 4.x is in the wild and
		// the floor is 3.14.0, so a naive string or first-digit compare would
		// wrongly reject a perfectly good toolchain.
		{"4.1.3", "3.14.0", 1},
		{"3.14.0", "4.1.3", -1},
		{"3.9.0", "3.14.0", -1},
		{"3.14.0", "3.9.0", 1},

		// `go version` reports two components for a .0 release (go1.26), while
		// the floor carries three. These must compare equal, not "older".
		{"1.26", "1.26.0", 0},
		{"1.26.0", "1.26", 0},
		{"1.26", "1.26.5", -1},

		// kind reports a leading zero major.
		{"0.31.0", "0.27.0", 1},
		{"0.9.0", "0.27.0", -1},
	}
	for _, c := range cases {
		if got := compareSemver(c.a, c.b); got != c.want {
			t.Errorf("compareSemver(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestOrLatestOrDash(t *testing.T) {
	if got := orLatest(""); got != "any" {
		t.Errorf("orLatest(\"\") = %q, want any", got)
	}
	if got := orLatest("1.2.3"); got != "≥1.2.3" {
		t.Errorf("orLatest(1.2.3) = %q, want ≥1.2.3", got)
	}
	if got := orDash(""); got != "-" {
		t.Errorf("orDash(\"\") = %q, want -", got)
	}
	if got := orDash("x"); got != "x" {
		t.Errorf("orDash(x) = %q, want x", got)
	}
}

func TestToolChecksHaveInstallHints(t *testing.T) {
	for _, tc := range toolChecks {
		if tc.name == "" {
			t.Error("toolCheck with empty name")
		}
		if tc.installHint == "" {
			t.Errorf("toolCheck %q missing installHint", tc.name)
		}
		if tc.versionRE == nil {
			t.Errorf("toolCheck %q missing versionRE", tc.name)
		}
	}
}

// The floors in toolChecks track the prerequisites table in README.md. This does
// not re-assert the numbers (they move), only that each is a parseable semver —
// a typo like "3.14" vs "3,14" would otherwise silently compare as 0 and let
// every version through.
func TestToolCheckFloorsAreParseable(t *testing.T) {
	for _, tc := range toolChecks {
		if tc.required == "" {
			continue // no minimum is a valid choice
		}
		if compareSemver(tc.required, tc.required) != 0 {
			t.Errorf("toolCheck %q: required %q does not compare equal to itself", tc.name, tc.required)
		}
		if compareSemver(tc.required, "0.0.0") != 1 {
			t.Errorf("toolCheck %q: required %q does not parse as a version above 0.0.0", tc.name, tc.required)
		}
	}
}

// Each versionRE must actually extract a version from the output its tool really
// prints. These samples are copied verbatim from the tools on a working machine.
func TestVersionRegexesMatchRealOutput(t *testing.T) {
	samples := map[string]string{
		"go":      "go version go1.26.5 darwin/arm64",
		"node":    "v22.23.1",
		"docker":  "Docker version 29.3.0, build 5927d80c76",
		"kubectl": "clientVersion:\n  gitVersion: v1.35.3\n",
		"helm":    "v4.1.3+gc94d381",
		"kind":    "kind version 0.31.0",
	}
	for _, tc := range toolChecks {
		out, ok := samples[tc.name]
		if !ok {
			t.Errorf("no sample output for toolCheck %q — add one so the regex stays honest", tc.name)
			continue
		}
		m := tc.versionRE.FindStringSubmatch(out)
		if m == nil {
			t.Errorf("toolCheck %q: versionRE did not match %q", tc.name, out)
			continue
		}
		if tc.required != "" && compareSemver(m[1], tc.required) < 0 {
			t.Errorf("toolCheck %q: extracted %q is below the floor %q — sample or floor is wrong", tc.name, m[1], tc.required)
		}
	}
}
