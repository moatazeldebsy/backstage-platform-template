package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var (
	aiKagentURL    string
	aiTimeout      int
	aiEnv          string
	aiBackstageURL string
)

// aiAgent is the KAgent agent `idp ai` talks to.
const aiAgent = "platform-assistant"

var aiCmd = &cobra.Command{
	Use:   "ai <message>",
	Short: "Ask the platform AI assistant in natural language",
	Long: `Send a natural-language request to the platform-assistant KAgent agent.
The agent has access to all platform tools: catalog search, service scaffolding,
test suite creation, contract testing, deployment listing, and user memory.

Set IDP_BACKSTAGE_USER_TOKEN to a Backstage *user* token to send the request
through Backstage's verified-identity route (/api/idp-ai-identity). The agent
then acts as you: user memory is bound to your identity and the consent gate
(docs/agent-approvals.md) applies. Without it the request goes straight to
KAgent unattributed.`,
	Example: `  idp ai "scaffold a Go payment service for team-platform"
  idp ai "what test suites does hello-service have?"
  idp ai "list all running deployments in services-dev"
  idp ai "check contract compatibility for payment-service"`,
	Args: cobra.MinimumNArgs(1),
	RunE: runAI,
}

func init() {
	aiCmd.Flags().StringVar(&aiKagentURL, "kagent-url", kagentBaseURL(), "KAgent base URL")
	aiCmd.Flags().IntVar(&aiTimeout, "timeout", 300, "Seconds to wait for agent response")
	aiCmd.Flags().StringVar(&aiEnv, "env", envLocal, fmt.Sprintf("Target environment: %s | %s", envLocal, envAWS))
	aiCmd.Flags().StringVar(&aiBackstageURL, "backstage-url", "", "Backstage base URL (used with IDP_BACKSTAGE_USER_TOKEN)")
}

// a2aTarget returns where to POST the A2A message. With a Backstage user
// token it goes through idpAiIdentityProxy.ts, which sets X-Backstage-User
// from the verified credentials; without one it falls back to KAgent directly.
func a2aTarget(kagentURL, backstageURL, userToken string) string {
	if userToken != "" {
		return backstageURL + "/api/idp-ai-identity/a2a/kagent/" + aiAgent
	}
	return kagentURL + "/a2a/kagent/" + aiAgent
}

func postA2A(client *http.Client, target, userToken string, payload []byte) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if userToken != "" {
		req.Header.Set("Authorization", "Bearer "+userToken)
	}
	return client.Do(req)
}

func kagentBaseURL() string {
	if v := os.Getenv("KAGENT_URL"); v != "" {
		return v
	}
	return "http://kagent.idp.local"
}

// a2a request types
type a2aReq struct {
	JSONRPC string    `json:"jsonrpc"`
	Method  string    `json:"method"`
	Params  a2aParams `json:"params"`
	ID      int       `json:"id"`
}
type a2aParams struct {
	Message a2aMsg `json:"message"`
}
type a2aMsg struct {
	MessageID string    `json:"messageId"`
	Role      string    `json:"role"`
	Parts     []a2aPart `json:"parts"`
}
type a2aPart struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

func runAI(_ *cobra.Command, args []string) error {
	userMessage := strings.Join(args, " ")

	payload, _ := json.Marshal(a2aReq{
		JSONRPC: "2.0",
		Method:  "message/send",
		Params: a2aParams{Message: a2aMsg{
			MessageID: fmt.Sprintf("%d", time.Now().UnixNano()),
			Role:      "user",
			Parts:     []a2aPart{{Kind: "text", Text: userMessage}},
		}},
		ID: 1,
	})

	userToken := os.Getenv("IDP_BACKSTAGE_USER_TOKEN")
	backstageURL := ""
	if userToken != "" {
		backstageURL = resolveBackstageURL(aiEnv, aiBackstageURL, rootDir())
	} else {
		fmt.Fprintln(os.Stderr, "[idp] Warning: IDP_BACKSTAGE_USER_TOKEN not set — request is unattributed "+
			"(no user memory, consent checks skipped). See `idp ai --help`.")
	}

	client := &http.Client{Timeout: time.Duration(aiTimeout) * time.Second}
	target := a2aTarget(aiKagentURL, backstageURL, userToken)
	// Taken before the POST, not after: message/send blocks until the agent has
	// finished (tens of seconds with tool calls), but KAgent creates the session
	// the moment the request arrives. The session lookup below matches on
	// created_at, so a post-response timestamp misses the session entirely.
	sentAt := time.Now()
	resp, err := postA2A(client, target, userToken, payload)
	if err != nil {
		return fmt.Errorf("A2A request to %s failed: %w", target, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized && userToken != "" {
		return fmt.Errorf("Backstage rejected IDP_BACKSTAGE_USER_TOKEN (401) — it must be a current user token, not a static service token")
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("A2A POST returned %d: %s", resp.StatusCode, string(body))
	}

	// Try to extract contextId from the A2A response body.
	var sessionID string
	var a2aResp map[string]interface{}
	if json.NewDecoder(resp.Body).Decode(&a2aResp) == nil {
		if result, ok := a2aResp["result"].(map[string]interface{}); ok {
			sessionID, _ = result["contextId"].(string)
		}
	}

	// If no contextId returned, poll the sessions list to find our session.
	if sessionID == "" {
		fmt.Fprintln(os.Stderr, "Connecting to agent…")
		deadline := time.Now().Add(30 * time.Second)
		for sessionID == "" && time.Now().Before(deadline) {
			time.Sleep(800 * time.Millisecond)
			r, err := client.Get(aiKagentURL + "/api/sessions")
			if err != nil || r.StatusCode != http.StatusOK {
				if r != nil {
					r.Body.Close()
				}
				continue
			}
			var body map[string]interface{}
			json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
			r.Body.Close()
			sessions, _ := body["data"].([]interface{})
			for _, s := range sessions {
				sess, _ := s.(map[string]interface{})
				if agentID, _ := sess["agent_id"].(string); agentID != "kagent__NS__platform_assistant" {
					continue
				}
				if createdStr, _ := sess["created_at"].(string); createdStr != "" {
					if t, err := time.Parse(time.RFC3339Nano, createdStr); err == nil {
						if sessionCreatedDuring(t, sentAt, time.Now()) {
							sessionID, _ = sess["id"].(string)
							break
						}
					}
				}
			}
		}
	}

	if sessionID == "" {
		return fmt.Errorf("could not find agent session — is KAgent running at %s?", aiKagentURL)
	}

	// Poll session until agent responds with text.
	fmt.Fprintln(os.Stderr, "Agent is thinking…")
	deadline := time.Now().Add(time.Duration(aiTimeout) * time.Second)
	attempt := 0
	for time.Now().Before(deadline) {
		base := math.Min(3000, 500*math.Pow(2, float64(attempt)))
		jitter := base * (0.8 + rand.Float64()*0.4)
		time.Sleep(time.Duration(jitter) * time.Millisecond)
		attempt++

		if elapsed := time.Since(sentAt).Round(time.Second); elapsed > 5*time.Second {
			fmt.Fprintf(os.Stderr, "\rAgent is thinking… (%s elapsed)   ", elapsed)
		}

		r, err := client.Get(fmt.Sprintf("%s/api/sessions/%s", aiKagentURL, sessionID))
		if err != nil || r.StatusCode != http.StatusOK {
			if r != nil {
				r.Body.Close()
			}
			continue
		}
		var sessBody map[string]interface{}
		json.NewDecoder(r.Body).Decode(&sessBody) //nolint:errcheck
		r.Body.Close()

		data, _ := sessBody["data"].(map[string]interface{})
		events, _ := data["events"].([]interface{})

		for _, ev := range events {
			evMap, _ := ev.(map[string]interface{})
			dataStr, _ := evMap["data"].(string)
			if dataStr == "" {
				continue
			}
			text, toolName := parseAgentEvent(dataStr, "platform_assistant")
			if toolName != "" {
				fmt.Fprintf(os.Stderr, "\r%-70s", toolStatusLabel(toolName))
			}
			if text != "" {
				fmt.Fprintln(os.Stderr, "") // clear status line
				fmt.Println(text)
				return nil
			}
		}
	}
	fmt.Fprintln(os.Stderr, "")
	return fmt.Errorf("agent did not respond within %ds", aiTimeout)
}

// parseAgentEvent extracts the reply text and any in-flight tool call from one
// KAgent session event authored by `author`. KAgent's Python runtime
// serialises ADK events with snake_case keys (author, content, function_call);
// the Go runtime serialises genai structs with Go field names (Author, Content)
// and camelCase part keys (functionCall). Accept both, or the CLI polls until
// --timeout while the answer sits in the session.
func parseAgentEvent(dataStr, author string) (text, toolName string) {
	var parsed map[string]interface{}
	if json.Unmarshal([]byte(dataStr), &parsed) != nil {
		return "", ""
	}
	field := func(m map[string]interface{}, keys ...string) interface{} {
		for _, k := range keys {
			if v, ok := m[k]; ok && v != nil {
				return v
			}
		}
		return nil
	}
	if a, _ := field(parsed, "author", "Author").(string); a != author {
		return "", ""
	}
	content, _ := field(parsed, "content", "Content").(map[string]interface{})
	parts, _ := field(content, "parts", "Parts").([]interface{})

	var textParts []string
	for _, p := range parts {
		part, _ := p.(map[string]interface{})
		if fc, ok := field(part, "function_call", "functionCall", "FunctionCall").(map[string]interface{}); ok {
			toolName, _ = field(fc, "name", "Name").(string)
		}
		if t, _ := field(part, "text", "Text").(string); t != "" {
			textParts = append(textParts, t)
		}
	}
	return strings.Join(textParts, ""), toolName
}

// sessionCreatedDuring reports whether a session created at `created` could
// belong to a request sent at `sentAt` and still being looked up at `now`.
// The 5s slack on both ends absorbs clock skew between this machine and the
// cluster.
func sessionCreatedDuring(created, sentAt, now time.Time) bool {
	return created.After(sentAt.Add(-5*time.Second)) && created.Before(now.Add(5*time.Second))
}

func toolStatusLabel(tool string) string {
	labels := map[string]string{
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
	if l, ok := labels[tool]; ok {
		return l
	}
	return fmt.Sprintf("Running %s…", tool)
}
