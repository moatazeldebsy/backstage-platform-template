"""
Prometheus metrics for ${{ values.name }}.

Registers three instruments:
  agent_invocations_total   — counter, labelled by status (success|error)
  agent_latency_seconds     — histogram, end-to-end /invoke latency
  llm_token_usage_total     — counter, labelled by token_type (prompt|completion)
"""
from prometheus_client import Counter, Histogram

AGENT_INVOCATIONS = Counter(
    "agent_invocations_total",
    "Total agent /invoke calls",
    ["status"],
)

AGENT_LATENCY = Histogram(
    "agent_latency_seconds",
    "End-to-end latency of a single agent invocation",
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0],
)

LLM_TOKEN_USAGE = Counter(
    "llm_token_usage_total",
    "LLM tokens consumed",
    ["token_type"],  # prompt | completion
)

TOOL_CALLS = Counter(
    "agent_tool_calls_total",
    "Number of tool calls made by the agent",
    ["tool_name"],
)
