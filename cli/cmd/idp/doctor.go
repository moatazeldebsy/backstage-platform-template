package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

var (
	doctorFix         bool
	doctorToolsOnly   bool
	doctorProjectOnly bool
)

var doctorCmd = &cobra.Command{
	Use:   "doctor",
	Short: "Check local tool versions and cluster health against project requirements",
	Long: `Checks that the tools this repo assumes (go, node, docker, kubectl, helm, kind)
are installed and meet the minimum version this repo was built against, then does a
handful of cheap cluster-reachability checks (backstage/argocd/monitoring namespaces).`,
	Example: `  idp doctor
  idp doctor --tools-only
  idp doctor --project-only
  idp doctor --fix`,
	RunE: runDoctor,
}

func init() {
	doctorCmd.Flags().BoolVar(&doctorFix, "fix", false, "Print install/upgrade commands for failed or missing tools")
	doctorCmd.Flags().BoolVar(&doctorToolsOnly, "tools-only", false, "Check tool versions only (skip cluster health)")
	doctorCmd.Flags().BoolVar(&doctorProjectOnly, "project-only", false, "Check cluster health only (skip tool versions)")
}

// toolCheck describes one required local tool.
type toolCheck struct {
	name        string
	required    string // minimum version, semver-ish; "" means presence-only
	args        []string
	versionRE   *regexp.Regexp
	installHint string
}

var toolChecks = []toolCheck{
	{name: "go", required: "1.21.0", args: []string{"version"}, versionRE: regexp.MustCompile(`go(\d+\.\d+(\.\d+)?)`), installHint: "brew install go"},
	{name: "node", required: "18.0.0", args: []string{"--version"}, versionRE: regexp.MustCompile(`v?(\d+\.\d+\.\d+)`), installHint: "brew install node@18"},
	{name: "docker", required: "20.0.0", args: []string{"--version"}, versionRE: regexp.MustCompile(`(\d+\.\d+\.\d+)`), installHint: "brew install --cask docker"},
	{name: "kubectl", required: "1.27.0", args: []string{"version", "--client", "-o", "yaml"}, versionRE: regexp.MustCompile(`gitVersion:\s*v?(\d+\.\d+\.\d+)`), installHint: "brew install kubectl"},
	{name: "helm", required: "3.12.0", args: []string{"version", "--short"}, versionRE: regexp.MustCompile(`v?(\d+\.\d+\.\d+)`), installHint: "brew install helm"},
	{name: "kind", required: "", args: []string{"--version"}, versionRE: regexp.MustCompile(`(\d+\.\d+\.\d+)`), installHint: "brew install kind"},
}

// clusterCheck is a cheap `kubectl get ns <name>` reachability probe.
var clusterChecks = []string{"backstage", "argocd", "monitoring"}

func runDoctor(_ *cobra.Command, _ []string) error {
	if doctorToolsOnly && doctorProjectOnly {
		return fmt.Errorf("--tools-only and --project-only are mutually exclusive")
	}

	failed := false

	if !doctorProjectOnly {
		if usesRancherDesktop() {
			fmt.Println("[idp] KUBERNETES_PROVIDER=rancher-desktop — skipping kind version check")
		}
		fmt.Printf("%-10s %-12s %-15s %s\n", "TOOL", "REQUIRED", "FOUND", "STATUS")
		fmt.Println(strings.Repeat("─", 55))
		for _, tc := range toolChecks {
			if tc.name == "kind" && usesRancherDesktop() {
				continue
			}
			status, found, ok := checkTool(tc)
			fmt.Printf("%-10s %-12s %-15s %s\n", tc.name, orLatest(tc.required), orDash(found), status)
			if !ok {
				failed = true
				if doctorFix {
					fmt.Printf("  fix: %s\n", tc.installHint)
				}
			}
		}
	}

	if !doctorToolsOnly {
		fmt.Println()
		fmt.Println("Cluster health:")
		for _, ns := range clusterChecks {
			ok := namespaceExists(ns)
			status := "ok"
			if !ok {
				status = "MISSING"
				failed = true
			}
			fmt.Printf("  namespace/%-12s %s\n", ns, status)
		}
	}

	if failed {
		return fmt.Errorf("one or more checks failed")
	}
	fmt.Println("\n✅ All checks passed!")
	return nil
}

func usesRancherDesktop() bool {
	if os.Getenv("KUBERNETES_PROVIDER") == "rancher-desktop" {
		return true
	}
	return keyFromEnvFile(rootDir()+"/local/.env", "KUBERNETES_PROVIDER") == "rancher-desktop"
}

// checkTool runs the tool's version command and compares against the minimum.
// Returns (status, foundVersion, ok).
func checkTool(tc toolCheck) (string, string, bool) {
	path, err := exec.LookPath(tc.name)
	if err != nil {
		return "MISSING", "", false
	}
	out, err := exec.Command(path, tc.args...).CombinedOutput()
	if err != nil {
		return "MISSING", "", false
	}
	m := tc.versionRE.FindStringSubmatch(string(out))
	if len(m) < 2 {
		return "ok (unverified)", "", true
	}
	found := m[1]
	if tc.required == "" {
		return "ok", found, true
	}
	if compareSemver(found, tc.required) < 0 {
		return "outdated", found, false
	}
	return "ok", found, true
}

// compareSemver returns -1, 0, 1 comparing a to b as dotted version numbers.
func compareSemver(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var av, bv int
		if i < len(as) {
			av, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			bv, _ = strconv.Atoi(bs[i])
		}
		if av != bv {
			if av < bv {
				return -1
			}
			return 1
		}
	}
	return 0
}

func namespaceExists(ns string) bool {
	path, err := exec.LookPath("kubectl")
	if err != nil {
		return false
	}
	return exec.Command(path, "get", "namespace", ns).Run() == nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func orLatest(s string) string {
	if s == "" {
		return "any"
	}
	return "≥" + s
}
