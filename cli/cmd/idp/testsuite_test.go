package main

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

// Cases for `idp scaffold test-suite` not already covered by template_test.go
// (mode validation, changed-flags-only forwarding, repo normalisation) or
// template_parity_test.go (every type's values satisfy its template). The flag
// variables are package-level, so tests reset them via resetTestSuiteFlags.

func TestSupportedTypesMatchesTemplateRef(t *testing.T) {
	// supportedTypes is the help text; a type added to templateRef but not
	// here is invisible to users, and the reverse is a type that cannot work.
	listed := strings.Fields(supportedTypes)
	var keys []string
	for k := range templateRef {
		keys = append(keys, k)
	}
	sort.Strings(listed)
	sort.Strings(keys)
	if !reflect.DeepEqual(listed, keys) {
		t.Fatalf("supportedTypes and templateRef keys differ:\n  help:        %v\n  templateRef: %v", listed, keys)
	}
}

func TestTestSuiteExtrasMapsFlagsToTemplateKeys(t *testing.T) {
	t.Cleanup(func() { resetTestSuiteFlags(t) })
	resetTestSuiteFlags(t)
	setFlag(t, "type", "chaos")
	setFlag(t, "experiments", "pod-kill, network-delay ,")
	setFlag(t, "target-url", "https://api.example.test")
	setFlag(t, "set", "extraParam=1")
	extra, err := testSuiteExtras(testSuiteCmd)
	if err != nil {
		t.Fatal(err)
	}
	if got := extra["experiments"]; !reflect.DeepEqual(got, []string{"pod-kill", "network-delay"}) {
		t.Errorf("experiments = %#v", got)
	}
	// --target-url is sent under every key a template may use for it.
	for _, k := range []string{"targetUrl", "baseUrl"} {
		if extra[k] != "https://api.example.test" {
			t.Errorf("%s = %#v", k, extra[k])
		}
	}
	if _, ok := extra["extraParam"]; !ok {
		t.Errorf("--set value missing: %#v", extra)
	}
}

func TestTestSuiteExtrasRejectsNonNumericThreshold(t *testing.T) {
	t.Cleanup(func() { resetTestSuiteFlags(t) })
	resetTestSuiteFlags(t)
	setFlag(t, "type", "visual")
	setFlag(t, "threshold", "lots")
	if _, err := testSuiteExtras(testSuiteCmd); err == nil || !strings.Contains(err.Error(), "--threshold must be a number") {
		t.Fatalf("expected a --threshold error, got %v", err)
	}
}

func TestSplitList(t *testing.T) {
	for in, want := range map[string][]string{
		"a,b":       {"a", "b"},
		" a , ,b, ": {"a", "b"},
		"":          nil,
		",,":        nil,
	} {
		if got := splitList(in); !reflect.DeepEqual(got, want) {
			t.Errorf("splitList(%q) = %#v, want %#v", in, got, want)
		}
	}
}

func TestFirstNonEmpty(t *testing.T) {
	if got := firstNonEmpty("", "", "b", "c"); got != "b" {
		t.Errorf("got %q, want b", got)
	}
	if got := firstNonEmpty("", ""); got != "" {
		t.Errorf("got %q, want empty", got)
	}
}
