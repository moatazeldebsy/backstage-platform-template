package main

import "testing"

func TestRunDeploy_MissingValuesFile(t *testing.T) {
	deployService = "definitely-not-a-real-service"
	deployNamespace = "services"
	deployEnv = envLocal
	deployDryRun = false

	err := runDeploy(nil, nil)
	if err == nil {
		t.Fatal("expected error for missing values file, got nil")
	}
}
