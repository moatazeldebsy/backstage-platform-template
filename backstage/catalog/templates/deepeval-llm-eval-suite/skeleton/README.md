# ${{ values.name }}

${{ values.description }}

DeepEval evaluation suite for the `${{ values.targetAgent | default(values.name) }}` AI agent.

## Quick start

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...

# DeepEval runner — shows pass/fail per metric with scores
deepeval test run tests/test_agent.py -v

# Or via pytest directly
pytest tests/test_agent.py -v
```

Reports are written to `results/report.html` and `results/report.xml`.

## Keeping evals in sync

When the agent's system prompt or tools change, update two things in `tests/conftest.py`:

1. **`SYSTEM_PROMPT`** — copy the new system message verbatim
2. **`TOOL_DEFINITIONS`** / **`TOOL_STUB_RESPONSES`** — add/remove entries to match the current tool list

## CI

The `eval.yml` workflow runs on push/PR to `tests/**`. It requires `ANTHROPIC_API_KEY`
to be set as a GitHub Actions repository secret. The HTML report is uploaded as the
`deepeval-report` artifact on every run (retained 30 days).
