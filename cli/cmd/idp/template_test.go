package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseRepo(t *testing.T) {
	cases := map[string]string{
		"acme/orders":                        "acme/orders",
		"github.com/acme/orders":             "acme/orders",
		"https://github.com/acme/orders":     "acme/orders",
		"https://github.com/acme/orders.git": "acme/orders",
		"https://github.com/acme/orders/":    "acme/orders",
		" acme/orders ":                      "acme/orders",
	}
	for in, want := range cases {
		owner, repo, err := parseRepo(in)
		if err != nil || owner+"/"+repo != want {
			t.Errorf("parseRepo(%q) = %s/%s, %v; want %s", in, owner, repo, err, want)
		}
	}
	for _, bad := range []string{"", "orders", "acme/", "/orders", "acme/orders/tree/main"} {
		if _, _, err := parseRepo(bad); err == nil {
			t.Errorf("parseRepo(%q) should fail", bad)
		}
	}
}

func TestParseSets(t *testing.T) {
	got, err := parseSets([]string{"name=orders", "url=http://x?a=b", "empty="})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"name": "orders", "url": "http://x?a=b", "empty": ""}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseSets = %v, want %v", got, want)
	}
	if _, err := parseSets([]string{"novalue"}); err == nil {
		t.Error("expected error for missing '='")
	}
}

func TestValidateTestSuiteMode(t *testing.T) {
	t.Cleanup(func() { resetTestSuiteFlags(t) })
	cases := []struct {
		name    string
		flags   map[string]string
		wantErr string
	}{
		{"pr-only needs target repo", map[string]string{"type": "unit", "language": "go"}, "--target-repo"},
		{"unit needs language", map[string]string{"type": "unit", "target-repo": "a/b"}, "--language"},
		{"target repo with local", map[string]string{"type": "playwright", "target-repo": "a/b", "local": "true"}, "--local"},
		{"contract rejects target repo", map[string]string{"type": "contract", "target-repo": "a/b"}, "doesn't take --target-repo"},
		{"api-only with local", map[string]string{"type": "deepeval", "local": "true", "agent-prompt": "p", "agent-tools": "t"}, "remove --local"},
		{"deepeval needs prompt", map[string]string{"type": "deepeval"}, "--agent-prompt"},
		{"bad repo", map[string]string{"type": "playwright", "target-repo": "nope"}, "owner/repo"},
		{"brownfield playwright ok", map[string]string{"type": "playwright", "target-repo": "https://github.com/a/b.git"}, ""},
		{"greenfield k6 ok", map[string]string{"type": "k6"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetTestSuiteFlags(t)
			for k, v := range tc.flags {
				setFlag(t, k, v)
			}
			err := validateTestSuiteMode()
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %v, want it to contain %q", err, tc.wantErr)
			}
		})
	}
	resetTestSuiteFlags(t)
	setFlag(t, "type", "playwright")
	setFlag(t, "target-repo", "https://github.com/a/b.git")
	if err := validateTestSuiteMode(); err != nil || tsTarget != "a/b" {
		t.Errorf("target repo should be normalised to a/b, got %q (%v)", tsTarget, err)
	}
}

func TestTestSuiteExtrasOnlyForwardsChangedFlags(t *testing.T) {
	t.Cleanup(func() { resetTestSuiteFlags(t) })
	resetTestSuiteFlags(t)
	setFlag(t, "type", "k6")
	extra, err := testSuiteExtras(testSuiteCmd)
	if err != nil {
		t.Fatal(err)
	}
	if len(extra) != 0 {
		t.Errorf("defaults should defer to the template, got %v", extra)
	}
	setFlag(t, "vus", "50")
	setFlag(t, "set", "jiraProjectKey=QA")
	extra, _ = testSuiteExtras(testSuiteCmd)
	if extra["vus"] != 50 || extra["jiraProjectKey"] != "QA" {
		t.Errorf("expected vus=50 and jiraProjectKey=QA, got %v", extra)
	}
}

func TestVersionCmd(t *testing.T) {
	var b strings.Builder
	versionCmd.SetOut(&b)
	versionCmd.Run(versionCmd, nil)
	if !strings.HasPrefix(b.String(), "idp version ") {
		t.Errorf("unexpected output %q", b.String())
	}
}
