package main

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

var (
	statusService   string
	statusNamespace string
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show deployment/pod status for a service, plus ArgoCD sync status if available",
	Example: `  idp status --service order-svc
  idp status --service order-svc --namespace services`,
	RunE: runStatus,
}

func init() {
	statusCmd.Flags().StringVar(&statusService, "service", "", "Service name (required)")
	statusCmd.Flags().StringVar(&statusNamespace, "namespace", "services", "Kubernetes namespace")
	_ = statusCmd.MarkFlagRequired("service")
}

func runStatus(_ *cobra.Command, _ []string) error {
	if _, err := exec.LookPath("kubectl"); err != nil {
		return fmt.Errorf("kubectl not found in PATH")
	}

	fmt.Printf("[idp] Kubernetes (namespace=%s, app=%s):\n", statusNamespace, statusService)
	kubeCmd := exec.Command("kubectl", "get", "deployment,pods",
		"-n", statusNamespace, "-l", "app="+statusService)
	kubeCmd.Stdout = os.Stdout
	kubeCmd.Stderr = os.Stderr
	if err := kubeCmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "[idp] Warning: kubectl lookup failed: %v\n", err)
	}

	fmt.Println("\n[idp] ArgoCD application:")
	argoCmd := exec.Command("kubectl", "get", "application", statusService,
		"-n", "argocd",
		"-o", "custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status")
	argoCmd.Stdout = os.Stdout
	argoCmd.Stderr = os.Stderr
	if err := argoCmd.Run(); err != nil {
		fmt.Println("  (no ArgoCD application found, or ArgoCD not reachable)")
	}

	return nil
}
