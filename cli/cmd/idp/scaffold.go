package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	scaffoldToken string
	scaffoldEnv   string
)

var scaffoldCmd = &cobra.Command{
	Use:   "scaffold",
	Short: "Scaffold platform resources",
}

func init() {
	f := scaffoldCmd.PersistentFlags()
	f.StringVar(&scaffoldToken, "token", "", "Backstage service token (overrides auto-detected token)")
	f.StringVar(&scaffoldEnv, "env", envLocal, fmt.Sprintf("Target environment: %s | %s", envLocal, envAWS))
	scaffoldCmd.AddCommand(serviceCmd)
	scaffoldCmd.AddCommand(testSuiteCmd)
}
