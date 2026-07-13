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
	Long: `Probes every known MCP server ingress with a lightweight health check.
idp-mcp-server and qa-mcp-server are always-on (ApplicationSet-managed); the
AI-stack servers require bootstrap-ai.sh and only warn (not fail) when down.`,
	RunE: runMcpStatus,
}

func init() {
	mcpCmd.AddCommand(mcpStatusCmd)
	mcpStatusCmd.Flags().StringVar(&mcpEnv, "env", envLocal, fmt.Sprintf("Target environment: %s | %s", envLocal, envAWS))
}

// mcpServer describes one known platform MCP server.
type mcpServer struct {
	name       string
	alwaysOn   bool // false => requires bootstrap-ai.sh; down is a warning, not a failure
	requiresAI bool
}

var mcpServers = []mcpServer{
	{name: "idp-mcp-server", alwaysOn: true},
	{name: "qa-mcp-server", alwaysOn: true},
	{name: "contract-mcp-server", alwaysOn: false, requiresAI: true},
	{name: "argocd-mcp-server", alwaysOn: false, requiresAI: true},
	{name: "github-mcp-server", alwaysOn: false, requiresAI: true},
	{name: "cost-mcp-server", alwaysOn: false, requiresAI: true},
	{name: "agent-event-router", alwaysOn: false, requiresAI: true},
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
			if s.requiresAI {
				note = "requires bootstrap-ai.sh"
			} else if s.alwaysOn {
				failed = true
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
