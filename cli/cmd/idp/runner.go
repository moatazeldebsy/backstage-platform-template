package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

var runnerRepo string

var runnerCmd = &cobra.Command{
	Use:   "runner",
	Short: "Manage GitHub Actions self-hosted runners",
}

var runnerSetupCmd = &cobra.Command{
	Use:     "setup",
	Short:   "Register and start a self-hosted runner for a scaffolded repo",
	Long:    `Thin wrapper around scripts/setup-runner.sh — registers a GitHub Actions runner for --repo and starts it.`,
	Example: `  idp runner setup --repo order-svc`,
	RunE:    runRunnerSetup,
}

func init() {
	runnerSetupCmd.Flags().StringVar(&runnerRepo, "repo", "", "Repository name to register a runner for (required)")
	_ = runnerSetupCmd.MarkFlagRequired("repo")
	runnerCmd.AddCommand(runnerSetupCmd)
}

func runRunnerSetup(_ *cobra.Command, _ []string) error {
	script := rootDir() + "/scripts/setup-runner.sh"
	if _, err := os.Stat(script); err != nil {
		return fmt.Errorf("setup-runner.sh not found at %s", script)
	}

	cmd := exec.Command(script, "--repo", runnerRepo)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Dir = rootDir()
	return cmd.Run()
}
