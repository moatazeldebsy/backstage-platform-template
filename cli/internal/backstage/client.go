package backstage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Client talks to the Backstage Scaffolder API.
type Client struct {
	base   string
	token  string
	client *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		base:   strings.TrimRight(baseURL, "/"),
		token:  token,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// GetEntity fetches a single catalog entity by kind/namespace/name.
func (c *Client) GetEntity(ctx context.Context, kind, namespace, name string) (map[string]any, error) {
	url := fmt.Sprintf("%s/api/catalog/entities/by-name/%s/%s/%s", c.base, kind, namespace, name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("catalog API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("catalog API returned %d: %s", resp.StatusCode, b)
	}
	var entity map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&entity); err != nil {
		return nil, fmt.Errorf("parsing entity response: %w", err)
	}
	return entity, nil
}

// Healthy returns true if Backstage responds to its healthcheck endpoint.
func (c *Client) Healthy(ctx context.Context) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/healthcheck", nil)
	if err != nil {
		return false
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// ScaffoldRequest holds the values forwarded to a Backstage service template.
type ScaffoldRequest struct {
	Name         string
	Type         string // nodejs | python | go | …; used when TemplateRef is empty
	TemplateRef  string // e.g. "react-frontend"; defaults to "<Type>-service"
	Owner        string
	Desc         string
	GHOrg        string
	CostCenter   string
	DeployTarget string // local | aws
	ClusterName  string // aws only
	AWSRegion    string // aws only
}

type taskPayload struct {
	TemplateRef string         `json:"templateRef"`
	Values      map[string]any `json:"values"`
}

type taskCreated struct {
	ID string `json:"id"`
}

// RepoURL formats an owner/repo pair the way RepoUrlPicker fields expect it.
func RepoURL(owner, repo string) string {
	return fmt.Sprintf("github.com?owner=%s&repo=%s", owner, repo)
}

// ServiceValues builds the scaffolder values for a golden-path service template.
func ServiceValues(req ScaffoldRequest) map[string]any {
	target := req.DeployTarget
	if target == "" {
		target = "local"
	}
	values := map[string]any{
		"name":         req.Name,
		"owner":        req.Owner,
		"description":  req.Desc,
		"repoUrl":      RepoURL(req.GHOrg, req.Name),
		"deployTarget": target,
	}
	if req.CostCenter != "" {
		values["costCenter"] = req.CostCenter
	}
	if target == "aws" {
		values["clusterName"] = req.ClusterName
		values["awsRegion"] = req.AWSRegion
	}
	return values
}

// ScaffoldService creates a scaffolder task and streams its log until completion.
func (c *Client) ScaffoldService(ctx context.Context, req ScaffoldRequest) error {
	ref := req.TemplateRef
	if ref == "" {
		ref = req.Type + "-service"
	}
	return c.RunTemplate(ctx, ref, ServiceValues(req))
}

// TestSuiteRequest holds the values forwarded to a Backstage test suite template.
type TestSuiteRequest struct {
	Name         string
	TemplateRef  string // e.g. "playwright-e2e-suite"
	Service      string
	Namespace    string
	GHOrg        string
	Owner        string
	Desc         string
	TargetRepo   string // owner/repo — set for brownfield (PR into an existing repo)
	ConsumerName string // pact / contract
	ProviderName string // pact / contract
	DDSite       string // datadog only
	DeviceFarm   string // appium only
	CloudGrid    string // playwright / visual only
	// Extra carries type-specific template values (vus, wcagLevel, language, …)
	// keyed by template parameter name.
	Extra map[string]any
}

// TestSuiteValues builds the scaffolder values for a test-suite template.
// It is deliberately a superset: RunTemplate drops whatever the chosen
// template doesn't declare (e.g. deploymentMode on PR-only templates).
func TestSuiteValues(req TestSuiteRequest) map[string]any {
	values := map[string]any{
		"name":          req.Name,
		"description":   req.Desc,
		"owner":         req.Owner,
		"targetService": fmt.Sprintf("component:default/%s", req.Service),
	}
	if req.TargetRepo != "" {
		owner, repo, _ := strings.Cut(req.TargetRepo, "/")
		values["deploymentMode"] = "add-to-existing"
		values["targetRepoUrl"] = RepoURL(owner, repo)
	} else {
		values["deploymentMode"] = "new-repository"
		values["repoUrl"] = RepoURL(req.GHOrg, req.Name)
	}
	if req.ConsumerName != "" {
		values["consumerName"] = req.ConsumerName
	}
	if req.ProviderName != "" {
		values["providerName"] = req.ProviderName
	}
	if req.DDSite != "" {
		values["datadogSite"] = req.DDSite
	}
	if req.DeviceFarm != "" {
		values["deviceFarm"] = req.DeviceFarm
	}
	// "none" is a real choice, not an absent one, so it must be forwarded —
	// omitting it would let the template fall back to its own default.
	if req.CloudGrid != "" {
		values["cloudGrid"] = req.CloudGrid
	}
	for k, v := range req.Extra {
		values[k] = v
	}
	return values
}

// ScaffoldTestSuite creates a scaffolder task for a test suite template.
func (c *Client) ScaffoldTestSuite(ctx context.Context, req TestSuiteRequest) error {
	return c.RunTemplate(ctx, req.TemplateRef, TestSuiteValues(req))
}

// GetTemplateSchema fetches a template entity and flattens its parameters.
func (c *Client) GetTemplateSchema(ctx context.Context, name string) (*TemplateSchema, error) {
	entity, err := c.GetEntity(ctx, "template", "default", name)
	if err != nil {
		return nil, err
	}
	spec, _ := entity["spec"].(map[string]any)
	return ParseTemplateSchema(spec["parameters"]), nil
}

// PrepareValues filters values to what the template declares and fails if a
// required parameter is missing — a clearer error than Backstage's 400. If the
// schema can't be read, values are returned unchanged and Backstage validates.
func (c *Client) PrepareValues(ctx context.Context, name string, values map[string]any) (map[string]any, error) {
	schema, err := c.GetTemplateSchema(ctx, name)
	if err != nil {
		fmt.Printf("[idp] Could not read template %q schema (%v) — sending values unvalidated\n", name, err)
		return values, nil
	}
	kept, _ := schema.Filter(values)
	schema.ApplyDefaults(kept)
	if err := schema.Coerce(kept); err != nil {
		return nil, err
	}
	if missing := schema.Missing(kept); len(missing) > 0 {
		return nil, fmt.Errorf("template %q is missing required parameter(s): %s", name, strings.Join(missing, ", "))
	}
	return kept, nil
}

// RunTemplate validates values against the template, creates a scaffolder
// task and streams its log until completion.
func (c *Client) RunTemplate(ctx context.Context, name string, values map[string]any) error {
	values, err := c.PrepareValues(ctx, name, values)
	if err != nil {
		return err
	}
	payload := taskPayload{
		TemplateRef: "template:default/" + name,
		Values:      values,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encoding request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.base+"/api/scaffolder/v2/tasks", bytes.NewReader(body))
	if err != nil {
		return err
	}
	c.setHeaders(httpReq)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("scaffolder API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("scaffolder API returned %d: %s", resp.StatusCode, b)
	}

	var task taskCreated
	if err := json.NewDecoder(resp.Body).Decode(&task); err != nil {
		return fmt.Errorf("parsing task response: %w", err)
	}
	fmt.Printf("[idp] Scaffolder task created: %s\n", task.ID)
	return c.streamTask(ctx, task.ID)
}

// TemplateSummary is one row of `idp template list`.
type TemplateSummary struct {
	Name  string
	Title string
	Type  string
	Tags  []string
}

// ListTemplates returns every Template entity in the catalog, sorted by name.
func (c *Client) ListTemplates(ctx context.Context) ([]TemplateSummary, error) {
	url := c.base + "/api/catalog/entities?filter=kind=template" +
		"&fields=metadata.name,metadata.title,metadata.tags,spec.type"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(req)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("catalog API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("catalog API returned %d: %s", resp.StatusCode, b)
	}
	var entities []struct {
		Metadata struct {
			Name  string   `json:"name"`
			Title string   `json:"title"`
			Tags  []string `json:"tags"`
		} `json:"metadata"`
		Spec struct {
			Type string `json:"type"`
		} `json:"spec"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&entities); err != nil {
		return nil, fmt.Errorf("parsing catalog response: %w", err)
	}
	out := make([]TemplateSummary, 0, len(entities))
	for _, e := range entities {
		out = append(out, TemplateSummary{Name: e.Metadata.Name, Title: e.Metadata.Title, Type: e.Spec.Type, Tags: e.Metadata.Tags})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

type sseEvent struct {
	Type string          `json:"type"`
	Body json.RawMessage `json:"body"`
}

type logBody struct {
	Message string `json:"message"`
	StepID  string `json:"stepId"`
}

// Backstage scaffolder emits completion events with body:
//
//	{ "message": "Run completed with status: completed" | "...failed" | "...cancelled" }
//
// The actual task status is on the task row, not in the event body — so we parse
// it from the message string. See StorageTaskBroker.complete() in
// @backstage/plugin-scaffolder-backend.
type completionBody struct {
	Message string `json:"message"`
	Error   *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
	// Output is the template's `output:` block, e.g. the PR or repo link.
	Output struct {
		Links []struct {
			Title string `json:"title"`
			URL   string `json:"url"`
		} `json:"links"`
	} `json:"output"`
}

// completionStatusRE captures the status word from a completion event message.
var completionStatusRE = regexp.MustCompile(`Run completed with status:\s*(\S+)`)

// streamTask reads the SSE event stream for a scaffolder task and prints log lines.
func (c *Client) streamTask(ctx context.Context, taskID string) error {
	// No client-level timeout — the context controls cancellation instead.
	streamClient := &http.Client{}
	url := fmt.Sprintf("%s/api/scaffolder/v2/tasks/%s/eventstream", c.base, taskID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	c.setHeaders(req)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := streamClient.Do(req)
	if err != nil {
		return fmt.Errorf("event stream: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("event stream returned %d: %s", resp.StatusCode, b)
	}

	// Use a larger scanner buffer for big SSE payloads.
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)

	var dataLines []string
	completed := false

	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimPrefix(line, "data:"))
		case line == "":
			if len(dataLines) > 0 {
				raw := strings.Join(dataLines, "")
				dataLines = nil
				done, err := c.handleEvent(raw)
				if err != nil {
					return err
				}
				if done {
					completed = true
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("reading event stream: %w", err)
	}
	if !completed {
		return fmt.Errorf("event stream ended without a completion event — the task may still be running; check %s", c.base)
	}
	return nil
}

// handleEvent processes one SSE event. Returns (true, nil) on successful
// completion, (false, err) on failure, (false, nil) for log/info events.
func (c *Client) handleEvent(raw string) (completed bool, err error) {
	var ev sseEvent
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		return false, nil // ignore malformed events
	}
	switch ev.Type {
	case "log":
		var b logBody
		if err := json.Unmarshal(ev.Body, &b); err == nil && b.Message != "" {
			fmt.Printf("[idp] [%s] %s\n", b.StepID, b.Message)
		}
	case "completion":
		var b completionBody
		if err := json.Unmarshal(ev.Body, &b); err != nil {
			return false, fmt.Errorf("parsing completion event: %w", err)
		}
		status := ""
		if m := completionStatusRE.FindStringSubmatch(b.Message); len(m) == 2 {
			status = m[1]
		}
		switch status {
		case "completed":
			fmt.Printf("[idp] Task completed\n")
			for _, l := range b.Output.Links {
				if l.URL != "" {
					fmt.Printf("[idp] %s: %s\n", l.Title, l.URL)
				}
			}
			return true, nil
		case "failed":
			msg := b.Message
			if b.Error != nil && b.Error.Message != "" {
				msg = b.Error.Message
			}
			return false, fmt.Errorf("scaffolder task failed: %s", msg)
		default:
			return false, fmt.Errorf("scaffolder task ended with unexpected status %q (message: %q)", status, b.Message)
		}
	}
	return false, nil
}

func (c *Client) setHeaders(req *http.Request) {
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
}
