package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var mcpEnv string

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Manage platform MCP servers",
}

var mcpStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check reachability of the platform's MCP servers",
	Long: `Probes the AI Gateway, LiteLLM, and every known MCP server ingress with a
lightweight health check. idp-mcp-server and qa-mcp-server are always-on
(ApplicationSet-managed) and fail the command when down; everything else
requires bootstrap-ai.sh (or bootstrap-ai.sh --adp) and only warns.

KAgent agents reach their tools only through the AI Gateway, so an up MCP
server with a down ai-gateway still leaves agents with no tools.`,
	RunE: runMcpStatus,
}

func init() {
	mcpCmd.AddCommand(mcpStatusCmd)
	mcpStatusCmd.Flags().StringVar(&mcpEnv, "env", envLocal, fmt.Sprintf("Target environment: %s | %s", envLocal, envAWS))
}

const (
	noteAI  = "requires bootstrap-ai.sh"
	noteADP = "requires bootstrap-ai.sh --adp"
)

// mcpServer describes one known platform MCP server (or AI-stack component
// the MCP path depends on).
type mcpServer struct {
	name     string
	alwaysOn bool   // true => down fails the command
	note     string // shown when down and not alwaysOn
}

var mcpServers = []mcpServer{
	{name: "ai-gateway", note: noteAI},
	{name: "litellm", note: noteAI},
	{name: "idp-mcp-server", alwaysOn: true},
	{name: "qa-mcp-server", alwaysOn: true},
	{name: "contract-mcp-server", note: noteAI},
	{name: "argocd-mcp-server", note: noteAI},
	{name: "github-mcp-server", note: noteAI},
	{name: "cost-mcp-server", note: noteAI},
	{name: "agent-event-router", note: noteAI},
	{name: "incident-mcp-server", note: noteADP},
	{name: "security-mcp-server", note: noteADP},
	{name: "approval-service", note: noteADP},
}

func runMcpStatus(_ *cobra.Command, _ []string) error {
	failed := false
	fmt.Printf("%-22s %-8s %-10s %s\n", "MCP SERVER", "STATUS", "LATENCY", "NOTE")
	fmt.Println(strings.Repeat("─", 65))
	for _, s := range mcpServers {
		url := mcpServerURL(s.name)
		status, latency, err := probeMcpServer(url)
		note := ""
		if err != nil {
			if s.alwaysOn {
				failed = true
			} else {
				note = s.note
			}
		}
		fmt.Printf("%-22s %-8s %-10s %s\n", s.name, status, latency, note)
	}
	if failed {
		return fmt.Errorf("one or more always-on MCP servers are unreachable")
	}
	fmt.Println("\n✅ All required MCP servers reachable!")
	return nil
}

func mcpServerURL(name string) string {
	if mcpEnv == envAWS {
		if d := os.Getenv("IDP_DOMAIN"); d != "" {
			return "https://" + name + "." + strings.TrimLeft(d, ".")
		}
	}
	return "http://" + name + ".idp.local"
}

// probeMcpServer does a short-timeout GET /health, falling back to GET / on 404.
func probeMcpServer(baseURL string) (status, latency string, err error) {
	client := &http.Client{Timeout: 3 * time.Second}
	start := time.Now()

	resp, reqErr := client.Get(baseURL + "/health")
	if reqErr == nil && resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		resp, reqErr = client.Get(baseURL)
	}
	elapsed := time.Since(start)
	if reqErr != nil {
		return "down", "-", fmt.Errorf("unreachable")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return "down", "-", fmt.Errorf("unreachable")
	}
	return "up", elapsed.Round(time.Millisecond).String(), nil
}
