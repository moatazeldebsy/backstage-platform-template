"""
DeepEval evaluation suite for the IDP assistant.

Replays representative conversations against Claude using the exact system
prompt and tool definitions deployed in kubernetes/kagent/idp-agent.yaml.
MCP tools are stubbed (see conftest.py) because the in-cluster MCP server is
not reachable from CI.

Run locally:
    export ANTHROPIC_API_KEY=sk-ant-...
    deepeval test run tests/test_idp_assistant.py

Or via pytest directly (skips DeepEval telemetry):
    pytest tests/test_idp_assistant.py -v
"""

import json
import os
import pytest

import anthropic as _anthropic
from deepeval.anthropic import Anthropic
from deepeval import assert_test
from deepeval.test_case import LLMTestCase, ToolCall
from deepeval.metrics import (
    AnswerRelevancyMetric,
    FaithfulnessMetric,
    ToolCorrectnessMetric,
)
from deepeval.tracing import trace, LlmSpanContext

from conftest import (
    SYSTEM_PROMPT,
    TOOL_DEFINITIONS,
    TOOL_STUB_RESPONSES,
)

MODEL = "claude-sonnet-4-6"
client = Anthropic()


def _call_agent(
    user_message: str,
    extra_messages: list[dict] | None = None,
    metrics: list | None = None,
) -> tuple[str, list[str]]:
    """
    Send a message to Claude with the IDP assistant system prompt and tools.
    Handles the tool-use loop: Claude calls a stub, gets the result, then
    produces a final text response.

    Returns (final_text_response, tools_called_in_order).
    """
    messages: list[dict] = list(extra_messages or [])
    messages.append({"role": "user", "content": user_message})

    tools_called: list[str] = []

    span_ctx = LlmSpanContext(metrics=metrics or [])
    with trace(llm_span_context=span_ctx):
        while True:
            response = client.messages.create(
                model=MODEL,
                max_tokens=1024,
                system=SYSTEM_PROMPT,
                tools=TOOL_DEFINITIONS,
                messages=messages,
            )

            if response.stop_reason == "tool_use":
                # Collect tool calls and inject stub results
                assistant_content = response.content
                messages.append({"role": "assistant", "content": assistant_content})

                tool_results = []
                for block in assistant_content:
                    if block.type == "tool_use":
                        tools_called.append(block.name)
                        stub = TOOL_STUB_RESPONSES.get(
                            block.name, json.dumps({"error": "unknown tool"})
                        )
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": stub,
                        })

                messages.append({"role": "user", "content": tool_results})

            else:
                # Final text response
                final_text = "".join(
                    block.text for block in response.content if hasattr(block, "text")
                )
                return final_text, tools_called


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def test_catalog_lookup_answer_relevancy():
    """Claude should answer a catalog lookup question using catalog_search."""
    metric = AnswerRelevancyMetric(threshold=0.7, model="gpt-4o-mini")
    output, _ = _call_agent(
        "What services are registered in the catalog?",
        metrics=[metric],
    )
    test_case = LLMTestCase(
        input="What services are registered in the catalog?",
        actual_output=output,
    )
    assert_test(test_case, [metric])


def test_service_metrics_faithfulness():
    """Claude should report only the metrics returned by get_service_metrics."""
    metric = FaithfulnessMetric(threshold=0.7, model="gpt-4o-mini")
    output, _ = _call_agent(
        "What is the error rate for hello-service?",
        metrics=[metric],
    )
    retrieval_context = [TOOL_STUB_RESPONSES["get_service_metrics"]]
    test_case = LLMTestCase(
        input="What is the error rate for hello-service?",
        actual_output=output,
        retrieval_context=retrieval_context,
    )
    assert_test(test_case, [metric])


def test_scaffold_flow_tool_correctness():
    """
    Claude must call list_templates → get_template_params → scaffold_service
    (in that order) when asked to scaffold a new service with all required
    fields provided.
    """
    metric = ToolCorrectnessMetric(threshold=1.0)
    output, tools_called = _call_agent(
        "Scaffold a Go service called payments-api owned by payments-team.",
        metrics=[metric],
    )

    expected_tool_calls = [
        ToolCall(name="list_templates"),
        ToolCall(name="get_template_params"),
        ToolCall(name="scaffold_service"),
    ]

    actual_tool_calls = [ToolCall(name=t) for t in tools_called]

    test_case = LLMTestCase(
        input="Scaffold a Go service called payments-api owned by payments-team.",
        actual_output=output,
        tools_called=actual_tool_calls,
        expected_tools=expected_tool_calls,
    )
    assert_test(test_case, [metric])


def test_list_deployments_answer_relevancy():
    """Claude should enumerate deployments returned by list_deployments."""
    metric = AnswerRelevancyMetric(threshold=0.7, model="gpt-4o-mini")
    output, _ = _call_agent(
        "What deployments are currently running?",
        metrics=[metric],
    )
    test_case = LLMTestCase(
        input="What deployments are currently running?",
        actual_output=output,
    )
    assert_test(test_case, [metric])


def test_no_template_hallucination():
    """Claude must not name templates from memory without calling list_templates."""
    metric = ToolCorrectnessMetric(threshold=1.0)
    output, tools_called = _call_agent(
        "What templates are available for scaffolding?",
        metrics=[metric],
    )

    # list_templates must be the first (and only required) tool call
    assert "list_templates" in tools_called, (
        f"Expected list_templates to be called, got: {tools_called}"
    )

    actual_tool_calls = [ToolCall(name=t) for t in tools_called]
    test_case = LLMTestCase(
        input="What templates are available for scaffolding?",
        actual_output=output,
        tools_called=actual_tool_calls,
        expected_tools=[ToolCall(name="list_templates")],
    )
    assert_test(test_case, [metric])
