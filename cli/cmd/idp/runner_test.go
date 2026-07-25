package main

import "testing"

func TestRunRunnerSetup_MissingScript(t *testing.T) {
	t.Chdir(t.TempDir())
	runnerRepo = "some-repo"

	err := runRunnerSetup(nil, nil)
	if err == nil {
		t.Fatal("expected error when setup-runner.sh is not found, got nil")
	}
}
