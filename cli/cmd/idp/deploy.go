package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
)

var (
	deployService   string
	deployNamespace string
	deployEnv       string
	deployDryRun    bool
)

var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy a service via helm upgrade --install",
	Long: `Deploys a scaffolded service using its generated helm-values-<env>.yaml,
the same file the scaffold templates write to services/<name>/.`,
	Example: `  idp deploy --service order-svc --env local
  idp deploy --service order-svc --namespace services --env aws --dry-run`,
	RunE: runDeploy,
}

func init() {
	deployCmd.Flags().StringVar(&deployService, "service", "", "Service name (required)")
	deployCmd.Flags().StringVar(&deployNamespace, "namespace", "services", "Kubernetes namespace")
	deployCmd.Flags().StringVar(&deployEnv, "env", envLocal, fmt.Sprintf("Target environment: %s | %s", envLocal, envAWS))
	deployCmd.Flags().BoolVar(&deployDryRun, "dry-run", false, "Pass --dry-run through to helm")
	_ = deployCmd.MarkFlagRequired("service")
}

func runDeploy(_ *cobra.Command, _ []string) error {
	valuesFile := fmt.Sprintf("services/%s/helm-values-%s.yaml", deployService, deployEnv)
	valuesPath := rootDir() + "/" + valuesFile
	if _, err := os.Stat(valuesPath); err != nil {
		return fmt.Errorf("values file not found: %s (has %q been scaffolded and does --env match?)", valuesFile, deployService)
	}

	chartPath := rootDir() + "/services/" + deployService + "/helm"
	if _, err := os.Stat(chartPath); err != nil {
		return fmt.Errorf("helm chart not found at services/%s/helm", deployService)
	}

	args := []string{"upgrade", "--install", deployService, chartPath,
		"--namespace", deployNamespace, "--create-namespace",
		"--values", valuesPath,
	}
	if deployDryRun {
		args = append(args, "--dry-run")
	}

	fmt.Printf("[idp] helm %s\n", strings.Join(args, " "))
	cmd := exec.Command("helm", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Dir = rootDir()
	return cmd.Run()
}
