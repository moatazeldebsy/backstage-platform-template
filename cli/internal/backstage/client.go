package backstage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
		base:  strings.TrimRight(baseURL, "/"),
		token: token,
		client: &http.Client{Timeout: 10 * time.Second},
	}
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

// ScaffoldRequest holds the values forwarded to the Backstage Scaffolder template.
type ScaffoldRequest struct {
	Name      string
	Type      string
	Namespace string
	Owner     string
	Desc      string
	GHOrg     string
}

type taskPayload struct {
	TemplateRef string         `json:"templateRef"`
	Values      map[string]any `json:"values"`
}

type taskCreated struct {
	ID string `json:"id"`
}

// ScaffoldService creates a scaffolder task and streams its log until completion.
func (c *Client) ScaffoldService(ctx context.Context, req ScaffoldRequest) error {
	payload := taskPayload{
		TemplateRef: fmt.Sprintf("template:default/%s-service", req.Type),
		Values: map[string]any{
			"name":        req.Name,
			"namespace":   req.Namespace,
			"owner":       req.Owner,
			"description": req.Desc,
			"repoUrl":     fmt.Sprintf("github.com?owner=%s&repo=%s", req.GHOrg, req.Name),
		},
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

// TestSuiteRequest holds the values forwarded to a Backstage test suite template.
type TestSuiteRequest struct {
	Name         string
	TemplateRef  string // e.g. "playwright-e2e-suite"
	Service      string
	Namespace    string
	GHOrg        string
	Owner        string
	Desc         string
	ConsumerName string // pact only
	ProviderName string // pact only
	DDSite       string // datadog only
}

// ScaffoldTestSuite creates a scaffolder task for a test suite template.
func (c *Client) ScaffoldTestSuite(ctx context.Context, req TestSuiteRequest) error {
	values := map[string]any{
		"name":           req.Name,
		"description":    req.Desc,
		"owner":          req.Owner,
		"targetService":  fmt.Sprintf("component:default/%s", req.Service),
		"deploymentMode": "new-repository",
		"repoUrl":        fmt.Sprintf("github.com?owner=%s&repo=%s", req.GHOrg, req.Name),
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
	payload := taskPayload{
		TemplateRef: "template:default/" + req.TemplateRef,
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

type sseEvent struct {
	Type string          `json:"type"`
	Body json.RawMessage `json:"body"`
}

type logBody struct {
	Message string `json:"message"`
	StepID  string `json:"stepId"`
}

type completionBody struct {
	Status string `json:"status"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

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
		switch b.Status {
		case "completed":
			fmt.Printf("[idp] Task completed: %s\n", b.Status)
			return true, nil
		case "failed":
			msg := b.Status
			if b.Error != nil {
				msg = b.Error.Message
			}
			return false, fmt.Errorf("scaffolder task failed: %s", msg)
		default:
			return false, fmt.Errorf("scaffolder task ended with unexpected status %q", b.Status)
		}
	}
	return false, nil
}

func (c *Client) setHeaders(req *http.Request) {
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
}
