"""
Shared fixtures for the ${{ values.name }} eval suite.

System prompt and tool definitions mirror the agent deployment manifest.
Update SYSTEM_PROMPT and TOOL_DEFINITIONS whenever the agent changes.
MCP tool responses are stubbed so the suite runs offline (no live cluster needed).
"""

import json
import pytest
from deepeval.models import AnthropicModel


SYSTEM_PROMPT = """${{ values.agentSystemPrompt }}"""

{%- set tool_list = values.agentTools.split(',') %}

TOOL_DEFINITIONS = [
{%- for tool in tool_list %}
    {
        "name": "{{ tool | trim }}",
        "description": "Tool: {{ tool | trim }} — update this description to match the deployed agent.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Input query or parameter"}
            },
        },
    },
{%- endfor %}
]

# Stub responses returned to Claude when it calls a tool during eval.
# Replace placeholder values with realistic fixture data for your agent.
TOOL_STUB_RESPONSES: dict[str, str] = {
{%- for tool in tool_list %}
    "{{ tool | trim }}": json.dumps({"result": "stub response for {{ tool | trim }} — replace with realistic fixture data"}),
{%- endfor %}
}


def get_judge_model() -> AnthropicModel:
    return AnthropicModel(model="${{ values.judgeModel }}")


JUDGE_MODEL = get_judge_model
