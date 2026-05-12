package main

import "github.com/spf13/cobra"

var scaffoldCmd = &cobra.Command{
	Use:   "scaffold",
	Short: "Scaffold platform resources",
}

func init() {
	scaffoldCmd.AddCommand(serviceCmd)
	scaffoldCmd.AddCommand(testSuiteCmd)
}
