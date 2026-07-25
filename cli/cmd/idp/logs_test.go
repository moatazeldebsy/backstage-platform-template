package main

import "testing"

func TestRunLogs_MissingKubectl(t *testing.T) {
	t.Setenv("PATH", "")
	logsService = "order-svc"
	logsNamespace = "services"
	logsFollow = false
	logsTail = 100

	err := runLogs(nil, nil)
	if err == nil {
		t.Fatal("expected error when kubectl is not in PATH, got nil")
	}
}
