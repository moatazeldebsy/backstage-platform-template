# test-deepeval

DeepEval LLM evaluation suite for the `idp-assistant` agent (Claude / Anthropic).

The harness replays representative conversations against Claude using the exact
system prompt and tool definitions from `kubernetes/kagent/idp-agent.yaml`. MCP
tools are stubbed with realistic fixture data so the suite runs offline (no
in-cluster MCP server required).

## Quick start

```bash
# Install dependencies
pip install -r requirements.txt

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run all evals (DeepEval runner — shows pass/fail per metric)
deepeval test run tests/test_idp_assistant.py

# Or via pytest directly
pytest tests/test_idp_assistant.py -v
```

## Evaluations

| Test | Metric | What it checks |
|------|--------|----------------|
| `test_catalog_lookup_answer_relevancy` | AnswerRelevancy ≥ 0.7 | Catalog query answers are on-topic |
| `test_service_metrics_faithfulness` | Faithfulness ≥ 0.7 | Claude only reports data from the tool result |
| `test_scaffold_flow_tool_correctness` | ToolCorrectness = 1.0 | Scaffold calls `list_templates → get_template_params → scaffold_service` in order |
| `test_list_deployments_answer_relevancy` | AnswerRelevancy ≥ 0.7 | Deployment listing answers are on-topic |
| `test_no_template_hallucination` | ToolCorrectness = 1.0 | `list_templates` is always called before naming templates |

## Keeping evals in sync with the agent

When `kubernetes/kagent/idp-agent.yaml` changes, update two things in
`tests/conftest.py`:

1. **`SYSTEM_PROMPT`** — copy the new `spec.declarative.systemMessage` verbatim
2. **`TOOL_DEFINITIONS`** / **`TOOL_STUB_RESPONSES`** — add/remove entries to
   match the tool list under `spec.declarative.tools`

## CI

The `eval.yml` workflow runs this suite on push/PR to `test-suites/test-deepeval/**`
or `kubernetes/kagent/idp-agent.yaml`. It requires `ANTHROPIC_API_KEY` to be set
as a GitHub Actions repository secret.

> **Note:** AnswerRelevancy and Faithfulness metrics use `claude-haiku-4-5-20251001`
> as the LLM judge. Only `ANTHROPIC_API_KEY` is required — no OpenAI key needed.
