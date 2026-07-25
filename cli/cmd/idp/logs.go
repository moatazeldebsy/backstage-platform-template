package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

var (
	logsService   string
	logsNamespace string
	logsFollow    bool
	logsTail      int
)

var logsCmd = &cobra.Command{
	Use:   "logs",
	Short: "Tail logs for a service's deployment",
	Example: `  idp logs --service order-svc
  idp logs --service order-svc -f
  idp logs --service order-svc --tail 200`,
	RunE: runLogs,
}

func init() {
	logsCmd.Flags().StringVar(&logsService, "service", "", "Service name (required)")
	logsCmd.Flags().StringVar(&logsNamespace, "namespace", "services", "Kubernetes namespace")
	logsCmd.Flags().BoolVarP(&logsFollow, "follow", "f", false, "Stream logs (like kubectl logs -f)")
	logsCmd.Flags().IntVar(&logsTail, "tail", 100, "Number of lines to show from the end of the logs")
	_ = logsCmd.MarkFlagRequired("service")
}

func runLogs(_ *cobra.Command, _ []string) error {
	if _, err := exec.LookPath("kubectl"); err != nil {
		return fmt.Errorf("kubectl not found in PATH")
	}

	args := []string{"logs", "deployment/" + logsService,
		"-n", logsNamespace,
		"--tail", fmt.Sprintf("%d", logsTail),
	}
	if logsFollow {
		args = append(args, "-f")
	}

	cmd := exec.Command("kubectl", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
