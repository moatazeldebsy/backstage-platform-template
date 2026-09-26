package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestKagentBaseURL(t *testing.T) {
	t.Run("returns KAGENT_URL when set", func(t *testing.T) {
		t.Setenv("KAGENT_URL", "http://my-kagent:8080")
		got := kagentBaseURL()
		if got != "http://my-kagent:8080" {
			t.Errorf("got %q, want http://my-kagent:8080", got)
		}
	})

	t.Run("returns default when env not set", func(t *testing.T) {
		t.Setenv("KAGENT_URL", "")
		got := kagentBaseURL()
		if got != "http://kagent.idp.local" {
			t.Errorf("got %q, want http://kagent.idp.local", got)
		}
	})
}

func TestToolStatusLabel(t *testing.T) {
	known := map[string]string{
		"list_templates":          "Fetching available templates…",
		"get_template_params":     "Reading template parameters…",
		"scaffold_service":        "Scaffolding service (may take ~60s)…",
		"catalog_search":          "Searching catalog…",
		"catalog_semantic_search": "Semantic catalog search…",
		"get_service_metrics":     "Fetching metrics…",
		"list_deployments":        "Listing deployments…",
		"list_test_suites":        "Fetching test suite catalog…",
		"scaffold_test_suite":     "Scaffolding test suite…",
		"get_user_memory":         "Loading your preferences…",
		"set_user_memory":         "Saving preferences…",
	}
	for tool, want := range known {
		t.Run("known: "+tool, func(t *testing.T) {
			got := toolStatusLabel(tool)
			if got != want {
				t.Errorf("toolStatusLabel(%q) = %q, want %q", tool, got, want)
			}
		})
	}

	t.Run("unknown tool gets generic running label", func(t *testing.T) {
		got := toolStatusLabel("my_custom_tool")
		if !strings.Contains(got, "my_custom_tool") {
			t.Errorf("expected tool name in label, got %q", got)
		}
	})

	t.Run("empty string gets generic label", func(t *testing.T) {
		got := toolStatusLabel("")
		if got == "" {
			t.Error("expected non-empty label for empty tool name")
		}
	})
}

func TestA2ATarget(t *testing.T) {
	if got := a2aTarget("http://kagent", "http://backstage", ""); got != "http://kagent/a2a/kagent/platform-assistant" {
		t.Errorf("without token: got %q", got)
	}
	if got := a2aTarget("http://kagent", "http://backstage", "tok"); got != "http://backstage/api/idp-ai-identity/a2a/kagent/platform-assistant" {
		t.Errorf("with token: got %q", got)
	}
}

func TestPostA2A_Headers(t *testing.T) {
	var gotAuth, gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Run("sends bearer token when set", func(t *testing.T) {
		resp, err := postA2A(srv.Client(), srv.URL, "user-tok", []byte(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if gotAuth != "Bearer user-tok" {
			t.Errorf("Authorization = %q, want Bearer user-tok", gotAuth)
		}
		if gotCT != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", gotCT)
		}
	})

	t.Run("no Authorization header without token", func(t *testing.T) {
		resp, err := postA2A(srv.Client(), srv.URL, "", []byte(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if gotAuth != "" {
			t.Errorf("Authorization = %q, want empty", gotAuth)
		}
	})
}

// Regression: sentAt used to be taken after message/send returned. Once the
// POST waited for the full agent run, a session created at the start of a 20s
// request fell outside the window and `idp ai` reported "could not find agent
// session" even though the agent had answered.
func TestSessionCreatedDuring(t *testing.T) {
	sentAt := time.Date(2026, 9, 24, 21, 56, 30, 0, time.UTC)
	now := sentAt.Add(20 * time.Second) // POST blocked for 20s

	cases := []struct {
		name    string
		created time.Time
		want    bool
	}{
		{"created as the request arrived", sentAt.Add(200 * time.Millisecond), true},
		{"created mid-request", sentAt.Add(10 * time.Second), true},
		{"small clock skew before send", sentAt.Add(-3 * time.Second), true},
		{"earlier session from a previous run", sentAt.Add(-2 * time.Minute), false},
		{"created well after lookup", now.Add(time.Minute), false},
	}
	for _, c := range cases {
		if got := sessionCreatedDuring(c.created, sentAt, now); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestParseAgentEvent(t *testing.T) {
	cases := []struct {
		name, data, wantText, wantTool string
	}{
		{
			"go runtime final answer",
			`{"Author":"platform_assistant","Content":{"role":"model","parts":[{"text":"no suites"}]}}`,
			"no suites", "",
		},
		{
			"go runtime tool call",
			`{"Author":"platform_assistant","Content":{"parts":[{"functionCall":{"name":"search_test_catalog","args":{}}}]}}`,
			"", "search_test_catalog",
		},
		{
			"python runtime answer and tool call",
			`{"author":"platform_assistant","content":{"parts":[{"function_call":{"name":"get_test_metrics"}},{"text":"a"},{"text":"b"}]}}`,
			"ab", "get_test_metrics",
		},
		{
			"user message is ignored",
			`{"Author":"user","Content":{"parts":[{"text":"what test suites?"}]}}`,
			"", "",
		},
		{"not json", `nope`, "", ""},
	}
	for _, c := range cases {
		text, tool := parseAgentEvent(c.data, "platform_assistant")
		if text != c.wantText || tool != c.wantTool {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.name, text, tool, c.wantText, c.wantTool)
		}
	}
}

// Regression: when the model call failed (e.g. Anthropic out of credits) the
// turn's A2A task failed within seconds but no agent event was written, so
// `idp ai` polled until --timeout. Observed 2026-09-26.
func TestFindFailedTurn(t *testing.T) {
	sentAt := time.Date(2026, 9, 26, 19, 37, 27, 0, time.UTC)
	mk := func(state, ts, text string) a2aTask {
		var tk a2aTask
		tk.Status.State, tk.Status.Timestamp = state, ts
		if text != "" {
			tk.Status.Message.Parts = []struct {
				Text string `json:"text"`
			}{{Text: text}}
		}
		return tk
	}
	cases := []struct {
		name  string
		tasks []a2aTask
		want  string
	}{
		{"failed during this turn", []a2aTask{mk("failed", "2026-09-26T19:37:29.310953219Z", "boom")}, "boom"},
		{"failure from an earlier turn", []a2aTask{mk("failed", "2026-09-25T10:00:00Z", "old")}, ""},
		{"small clock skew", []a2aTask{mk("failed", "2026-09-26T19:37:24Z", "skewed")}, "skewed"},
		{"still working / completed", []a2aTask{mk("working", "2026-09-26T19:37:29Z", ""), mk("completed", "2026-09-26T19:37:30Z", "")}, ""},
		{"rejected without text", []a2aTask{mk("rejected", "2026-09-26T19:37:29Z", "")}, `the agent's task ended as "rejected"`},
		{"malformed timestamp", []a2aTask{mk("failed", "not-a-date", "x")}, ""},
	}
	for _, c := range cases {
		if got := findFailedTurn(c.tasks, sentAt); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestDescribeAgentFailure(t *testing.T) {
	// Real message from a failed platform-assistant task, abbreviated.
	noCredit := `anthropic API error: POST "http://ai-gateway.ml-platform.svc.cluster.local:3000/v1/messages": 400 Bad Request {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}`
	cases := []struct{ raw, want string }{
		{noCredit, "out of credits"},
		{"Error code: 429 - insufficient_quota", "run out of quota"},
		{`401 {"type":"authentication_error","message":"invalid x-api-key"}`, "rejected the platform's API key"},
		{"429 rate_limit_error", "rate-limiting"},
		{"529 overloaded_error", "overloaded"},
		{"something odd", "failed before it could answer"},
	}
	for _, c := range cases {
		if got := describeAgentFailure(c.raw); !strings.Contains(got, c.want) {
			t.Errorf("describeAgentFailure(%.40q) = %q, want it to contain %q", c.raw, got, c.want)
		}
	}
	if got := describeAgentFailure(strings.Repeat("x", 2000)); len(got) > 400 {
		t.Errorf("detail not shortened: %d chars", len(got))
	}
}
