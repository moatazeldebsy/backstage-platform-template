package main

import "testing"

func TestRunStatus_MissingKubectl(t *testing.T) {
	t.Setenv("PATH", "")
	statusService = "order-svc"
	statusNamespace = "services"

	err := runStatus(nil, nil)
	if err == nil {
		t.Fatal("expected error when kubectl is not in PATH, got nil")
	}
}
