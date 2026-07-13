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
