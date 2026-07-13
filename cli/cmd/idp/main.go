package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var version = "dev"

var rootCmd = &cobra.Command{
	Use:     "idp",
	Short:   "IDP CLI — scaffold and manage platform resources",
	Version: version,
}

func init() {
	rootCmd.AddCommand(scaffoldCmd)
	rootCmd.AddCommand(aiCmd)
	rootCmd.AddCommand(doctorCmd)
	rootCmd.AddCommand(contextCmd)
	rootCmd.AddCommand(learnCmd)
	rootCmd.AddCommand(tipCmd)
	rootCmd.AddCommand(mcpCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
