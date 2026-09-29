package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/YOUR_GITHUB_ORG/backstage-idp-starter/cli/internal/backstage"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var (
	tplTag        string
	tplSet        []string
	tplValuesFile string
	tplDryRun     bool
	tplURL        string
)

var templateCmd = &cobra.Command{
	Use:   "template",
	Short: "List, inspect and run any Backstage software template",
	Long: `Generic access to every scaffolder template in the catalog — infrastructure
(S3, RDS, Kafka, DynamoDB, SQS), namespaces, secrets, SLOs, canary rollouts,
decommissioning, AI agents, MCP servers, and the enable-* brownfield add-ons.

'idp scaffold service' and 'idp scaffold test-suite' are typed shortcuts for
the most common templates; 'idp template run' reaches all the others.`,
}

var templateListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the software templates registered in Backstage",
	Example: `  idp template list
  idp template list --tag crossplane`,
	Args: cobra.NoArgs,
	RunE: runTemplateList,
}

var templateParamsCmd = &cobra.Command{
	Use:     "params <template>",
	Short:   "Show a template's parameters (type, required, allowed values, default)",
	Example: `  idp template params s3-bucket-crossplane`,
	Args:    cobra.ExactArgs(1),
	RunE:    runTemplateParams,
}

var templateRunCmd = &cobra.Command{
	Use:   "run <template>",
	Short: "Run a template through the Backstage Scaffolder and stream its log",
	Long: `Run any software template. Values come from --values (YAML or JSON file)
and --set key=value (repeatable; --set wins). Values are converted to the
types the template declares, undeclared keys are dropped, and missing
required parameters are reported before a task is created.`,
	Example: `  # Self-service S3 bucket via Crossplane
  idp template run s3-bucket-crossplane --set name=orders-archive \
    --set owner=group:default/platform-team

  # Brownfield: SonarCloud + Snyk scanning on an existing repo (opens a PR)
  idp template run enable-security-scanning \
    --set targetRepoUrl='github.com?owner=my-org&repo=orders' --set owner=group:default/payments

  # Validate values without creating anything
  idp template run decommission-service --values decommission.yaml --dry-run`,
	Args: cobra.ExactArgs(1),
	RunE: runTemplateRun,
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the idp CLI version",
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, _ []string) {
		fmt.Fprintln(cmd.OutOrStdout(), "idp version "+version)
	},
}

func init() {
	pf := templateCmd.PersistentFlags()
	pf.StringVar(&scaffoldToken, "token", "", "Backstage service token (overrides auto-detected token)")
	pf.StringVar(&scaffoldEnv, "env", envLocal, fmt.Sprintf("Target environment: %s | %s", envLocal, envAWS))
	pf.StringVar(&tplURL, "backstage-url", "", "Backstage base URL (auto-resolved from IDP_BACKSTAGE_URL / IDP_DOMAIN when --env aws)")

	templateListCmd.Flags().StringVar(&tplTag, "tag", "", "Only show templates with this tag")
	templateRunCmd.Flags().StringArrayVar(&tplSet, "set", nil, "Template parameter as key=value (repeatable)")
	templateRunCmd.Flags().StringVar(&tplValuesFile, "values", "", "YAML or JSON file of template parameters")
	templateRunCmd.Flags().BoolVar(&tplDryRun, "dry-run", false, "Validate and print the values without creating a task")

	templateCmd.AddCommand(templateListCmd, templateParamsCmd, templateRunCmd)
}

func templateClient() (*backstage.Client, string) {
	u := resolveBackstageURL(scaffoldEnv, tplURL, rootDir())
	return backstage.NewClient(u, resolveToken(scaffoldEnv, scaffoldToken, rootDir())), u
}

func runTemplateList(cmd *cobra.Command, _ []string) error {
	client, u := templateClient()
	tpls, err := client.ListTemplates(cmd.Context())
	if err != nil {
		return fmt.Errorf("listing templates from %s: %w", u, err)
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tTYPE\tTITLE\tTAGS")
	for _, t := range tpls {
		if tplTag != "" && !contains(t.Tags, tplTag) {
			continue
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", t.Name, t.Type, t.Title, strings.Join(t.Tags, ","))
	}
	return w.Flush()
}

func runTemplateParams(cmd *cobra.Command, args []string) error {
	client, u := templateClient()
	schema, err := client.GetTemplateSchema(cmd.Context(), args[0])
	if err != nil {
		return fmt.Errorf("reading template %q from %s: %w", args[0], u, err)
	}
	required := map[string]bool{}
	for _, r := range schema.Required {
		required[r] = true
	}
	keys := make([]string, 0, len(schema.Props))
	for k := range schema.Props {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "PARAMETER\tTYPE\tREQUIRED\tALLOWED\tDEFAULT")
	for _, k := range keys {
		p := schema.Props[k]
		fmt.Fprintf(w, "%s\t%s\t%v\t%s\t%s\n", k, p.Type, required[k], joinAny(p.Enum), fmtAny(p.Default))
	}
	if err := w.Flush(); err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), "\nConditional parameters (e.g. repoUrl vs targetRepoUrl) are checked at run time.")
	return nil
}

func runTemplateRun(cmd *cobra.Command, args []string) error {
	values := map[string]any{}
	if tplValuesFile != "" {
		data, err := os.ReadFile(tplValuesFile)
		if err != nil {
			return err
		}
		// YAML is a superset of JSON, so one decoder handles both.
		if err := yaml.Unmarshal(data, &values); err != nil {
			return fmt.Errorf("parsing %s: %w", tplValuesFile, err)
		}
	}
	sets, err := parseSets(tplSet)
	if err != nil {
		return err
	}
	for k, v := range sets {
		values[k] = v
	}

	client, u := templateClient()
	if !client.Healthy(cmd.Context()) {
		return fmt.Errorf("Backstage is not reachable at %s", u)
	}
	if tplDryRun {
		prepared, err := client.PrepareValues(cmd.Context(), args[0], values)
		if err != nil {
			return err
		}
		return printValues(args[0], prepared)
	}
	return client.RunTemplate(cmd.Context(), args[0], values)
}

// parseSets turns repeated key=value flags into a map. Values stay strings;
// the template schema converts them to the declared type before sending.
func parseSets(sets []string) (map[string]any, error) {
	out := map[string]any{}
	for _, s := range sets {
		k, v, ok := strings.Cut(s, "=")
		if !ok || k == "" {
			return nil, fmt.Errorf("--set expects key=value (got %q)", s)
		}
		out[k] = v
	}
	return out, nil
}

// parseRepo accepts owner/repo, github.com/owner/repo, or a full https/.git URL.
func parseRepo(s string) (owner, repo string, err error) {
	s = strings.TrimSpace(s)
	if u, perr := url.Parse(s); perr == nil && u.Host != "" {
		s = u.Path
	}
	s = strings.TrimPrefix(s, "github.com/")
	s = strings.TrimSuffix(strings.Trim(s, "/"), ".git")
	owner, repo, ok := strings.Cut(s, "/")
	if !ok || owner == "" || repo == "" || strings.Contains(repo, "/") {
		return "", "", fmt.Errorf("--target-repo must be owner/repo or a GitHub repo URL (got %q)", s)
	}
	return owner, repo, nil
}

// printValues shows what would be sent to the scaffolder, without sending it.
func printValues(template string, values map[string]any) error {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false) // keep repoUrl's "&" readable
	enc.SetIndent("", "  ")
	if err := enc.Encode(values); err != nil {
		return err
	}
	fmt.Printf("[idp] Dry run — template:default/%s would be run with:\n%s", template, b.String())
	return nil
}

// previewValues is the offline counterpart of Client.PrepareValues: it checks
// values against the template.yaml in this repo checkout, when there is one.
func previewValues(template string, values map[string]any) error {
	schema, err := localTemplateSchema(rootDir(), template)
	if err != nil {
		fmt.Printf("[idp] %v — showing values unvalidated\n", err)
		return printValues(template, values)
	}
	kept, _ := schema.Filter(values)
	if err := schema.Coerce(kept); err != nil {
		return err
	}
	if missing := schema.Missing(kept); len(missing) > 0 {
		return fmt.Errorf("template %q is missing required parameter(s): %s", template, strings.Join(missing, ", "))
	}
	return printValues(template, kept)
}

// localTemplateSchema reads backstage/catalog/templates/<name>/template.yaml under root.
func localTemplateSchema(root, name string) (*backstage.TemplateSchema, error) {
	path := filepath.Join(root, "backstage", "catalog", "templates", name, "template.yaml")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("template %q not found in this checkout", name)
	}
	var doc struct {
		Spec struct {
			Parameters any `yaml:"parameters"`
		} `yaml:"spec"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return backstage.ParseTemplateSchema(doc.Spec.Parameters), nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func joinAny(vals []any) string {
	parts := make([]string, len(vals))
	for i, v := range vals {
		parts[i] = fmt.Sprint(v)
	}
	return strings.Join(parts, "|")
}

func fmtAny(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
