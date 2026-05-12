package main

import "github.com/spf13/cobra"

var scaffoldToken string

var scaffoldCmd = &cobra.Command{
	Use:   "scaffold",
	Short: "Scaffold platform resources",
}

func init() {
	scaffoldCmd.PersistentFlags().StringVar(&scaffoldToken, "token", "", "Backstage service token (overrides auto-detected token)")
	scaffoldCmd.AddCommand(serviceCmd)
	scaffoldCmd.AddCommand(testSuiteCmd)
}
