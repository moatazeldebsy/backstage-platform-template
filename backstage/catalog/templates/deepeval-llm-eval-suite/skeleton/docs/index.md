# ${{ values.name }}

${{ values.description }}

## Overview

DeepEval LLM evaluation suite targeting **${{ values.targetAgent }}**.

- **Owner:** ${{ values.owner }}
- **LLM Judge:** `${{ values.judgeModel }}`

## Running Evaluations

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
deepeval test run tests/test_agent.py -v
```

## Metrics

| Metric | Description |
|--------|-------------|
| Answer Relevancy | Checks that responses address the input query |
| Faithfulness | Verifies responses are grounded in the retrieved context |
| Tool Correctness | Validates the agent called the right tools with valid arguments |

## CI

Evaluations run automatically on every push and pull request via GitHub Actions.
Set the `ANTHROPIC_API_KEY` repository secret to enable the LLM judge.
