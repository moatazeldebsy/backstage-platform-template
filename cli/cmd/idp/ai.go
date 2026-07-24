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
	aiKagentURL string
	aiTimeout   int
)

var aiCmd = &cobra.Command{
	Use:   "ai <message>",
	Short: "Ask the platform AI assistant in natural language",
	Long: `Send a natural-language request to the platform-assistant KAgent agent.
The agent has access to all platform tools: catalog search, service scaffolding,
test suite creation, contract testing, deployment listing, and user memory.`,
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
	MessageID string     `json:"messageId"`
	Role      string     `json:"role"`
	Parts     []a2aPart  `json:"parts"`
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

	client := &http.Client{Timeout: time.Duration(aiTimeout) * time.Second}
	a2aURL := aiKagentURL + "/a2a/kagent/platform-assistant"
	resp, err := client.Post(a2aURL, "application/json", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("A2A request failed (is KAgent running at %s?): %w", aiKagentURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("A2A POST returned %d: %s", resp.StatusCode, string(body))
	}

	sentAt := time.Now()

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
						if t.After(sentAt.Add(-5*time.Second)) && t.Before(time.Now().Add(5*time.Second)) {
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
			var parsed map[string]interface{}
			if json.Unmarshal([]byte(dataStr), &parsed) != nil {
				continue
			}
			if author, _ := parsed["author"].(string); author != "platform_assistant" {
				continue
			}
			content, _ := parsed["content"].(map[string]interface{})
			parts, _ := content["parts"].([]interface{})

			// Show active tool as status
			for _, p := range parts {
				part, _ := p.(map[string]interface{})
				if fc, ok := part["function_call"].(map[string]interface{}); ok {
					toolName, _ := fc["name"].(string)
					label := toolStatusLabel(toolName)
					fmt.Fprintf(os.Stderr, "\r%-70s", label)
				}
			}

			// Collect text response
			var textParts []string
			for _, p := range parts {
				part, _ := p.(map[string]interface{})
				if text, ok := part["text"].(string); ok && text != "" {
					textParts = append(textParts, text)
				}
			}
			if len(textParts) > 0 {
				fmt.Fprintln(os.Stderr, "") // clear status line
				fmt.Println(strings.Join(textParts, ""))
				return nil
			}
		}
	}
	fmt.Fprintln(os.Stderr, "")
	return fmt.Errorf("agent did not respond within %ds", aiTimeout)
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
