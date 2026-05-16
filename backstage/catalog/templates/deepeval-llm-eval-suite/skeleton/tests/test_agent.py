"""
DeepEval evaluation suite for ${{ values.name }}.

Replays representative conversations against Claude using the system prompt
and tool definitions in conftest.py. MCP tools are stubbed so the suite runs
offline — no live cluster or MCP server required.

Run locally:
    export ANTHROPIC_API_KEY=sk-ant-...
    deepeval test run tests/test_agent.py -v

Or via pytest directly:
    pytest tests/test_agent.py -v
"""

import json
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
    JUDGE_MODEL,
)

MODEL = "claude-sonnet-4-6"
client = Anthropic()


def _call_agent(
    user_message: str,
    extra_messages: list[dict] | None = None,
    metrics: list | None = None,
) -> tuple[str, list[str]]:
    """
    Send a message to Claude with the agent system prompt and tools.
    Handles the tool-use loop and returns (final_text_response, tools_called).
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
                final_text = "".join(
                    block.text for block in response.content if hasattr(block, "text")
                )
                return final_text, tools_called


# ---------------------------------------------------------------------------
# Starter test cases — customise inputs and expected_tools for your agent
# ---------------------------------------------------------------------------

{%- set first_tool = (values.agentTools.split(',') | first) | trim %}

def test_answer_relevancy():
    """Agent responses should be relevant to the question asked."""
    metric = AnswerRelevancyMetric(threshold=0.7, model=JUDGE_MODEL())
    output, _ = _call_agent(
        "What can you help me with?",
        metrics=[metric],
    )
    test_case = LLMTestCase(
        input="What can you help me with?",
        actual_output=output,
    )
    assert_test(test_case, [metric])


def test_faithfulness():
    """Agent should only report information returned by tools, not hallucinate."""
    metric = FaithfulnessMetric(threshold=0.7, model=JUDGE_MODEL())
    output, _ = _call_agent(
        "Give me the latest information you have.",
        metrics=[metric],
    )
    retrieval_context = [TOOL_STUB_RESPONSES.get("{{ first_tool }}", "{}")]
    test_case = LLMTestCase(
        input="Give me the latest information you have.",
        actual_output=output,
        retrieval_context=retrieval_context,
    )
    assert_test(test_case, [metric])


def test_tool_correctness():
    """Agent must call the expected tool when given a clear task."""
    metric = ToolCorrectnessMetric(threshold=1.0, model=JUDGE_MODEL())
    output, tools_called = _call_agent(
        "Use {{ first_tool }} to get information.",
        metrics=[metric],
    )

    assert "{{ first_tool }}" in tools_called, (
        f"Expected '{{ first_tool }}' to be called, got: {tools_called}"
    )

    actual_tool_calls = [ToolCall(name=t) for t in tools_called]
    test_case = LLMTestCase(
        input="Use {{ first_tool }} to get information.",
        actual_output=output,
        tools_called=actual_tool_calls,
        expected_tools=[ToolCall(name="{{ first_tool }}")],
    )
    assert_test(test_case, [metric])
