"""Graph-level tests: each node, the routing between them, and one full run.

The model and the MCP tools are fakes — no test here makes a network call or
spends a token. What is asserted is the behaviour the graph promises: a missing
tool, a failing tool or no tools at all degrade the answer instead of failing
the request, and the final answer is built from what the tools returned.
"""

import asyncio
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage

from src import graph


class FakeModel:
    """Stands in for ChatAnthropic / ChatOllama: records prompts, returns a fixed reply."""

    def __init__(self, reply="fake reply", tool_calls=None):
        self.reply = reply
        self.tool_calls = tool_calls or []
        self.prompts = []

    def bind_tools(self, tools):
        self.bound = tools
        return self

    async def ainvoke(self, messages):
        self.prompts.append(messages)
        return AIMessage(content=self.reply, tool_calls=self.tool_calls)


class FakeTool:
    def __init__(self, name, output=None, error=None):
        self.name = name
        self._output = output
        self._error = error

    async def ainvoke(self, args):
        if self._error:
            raise self._error
        return self._output


def run(coro):
    return asyncio.run(coro)


def tools_returning(tools):
    async def _load():
        return tools

    return _load


def state(**overrides):
    base = {
        "messages": [HumanMessage(content="Which deployments are unhealthy?")],
        "plan": "",
        "tool_results": [],
        "iterations": 0,
        "done": False,
    }
    base.update(overrides)
    return base


def test_default_backend_routes_through_the_ai_gateway(monkeypatch):
    monkeypatch.delenv("MODEL_BACKEND", raising=False)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    model = graph._model()
    assert type(model).__name__ == "ChatAnthropic"
    assert "ai-gateway" in str(model.anthropic_api_url)


def test_ollama_backend(monkeypatch):
    monkeypatch.setenv("MODEL_BACKEND", "ollama")
    assert type(graph._model()).__name__ == "ChatOllama"


def test_plan_node_records_the_plan_and_counts_the_iteration():
    fake = FakeModel(reply="Need deployment status from the argocd tools.")
    with patch.object(graph, "_model", return_value=fake):
        out = run(graph.plan_node(state()))
    assert out == {
        "plan": "Need deployment status from the argocd tools.",
        "iterations": 1,
    }
    assert "Which deployments are unhealthy?" in fake.prompts[0][-1].content


def test_select_tools_without_any_mcp_tools_answers_without_them():
    with patch.object(graph, "load_mcp_tools", tools_returning([])):
        assert run(graph.select_tools_node(state())) == {"tool_results": []}


def test_select_tools_binds_tools_and_returns_the_model_turn():
    fake = FakeModel(tool_calls=[{"name": "list_deployments", "args": {}, "id": "1"}])
    with patch.object(
        graph, "load_mcp_tools", tools_returning([FakeTool("list_deployments")])
    ), patch.object(graph, "_model", return_value=fake):
        out = run(graph.select_tools_node(state()))
    assert [t.name for t in fake.bound] == ["list_deployments"]
    assert out["messages"][0].tool_calls[0]["name"] == "list_deployments"


def test_act_without_tool_calls_keeps_existing_results():
    out = run(graph.act_node(state(tool_results=[{"tool": "x", "output": "y"}])))
    assert out == {"tool_results": [{"tool": "x", "output": "y"}]}


def test_act_records_output_unknown_tools_and_failures_without_raising():
    calls = [
        {"name": "list_deployments", "args": {}, "id": "1"},
        {"name": "does_not_exist", "args": {}, "id": "2"},
        {"name": "flaky", "args": {}, "id": "3"},
    ]
    tools = [
        FakeTool("list_deployments", output="2 degraded"),
        FakeTool("flaky", error=RuntimeError("boom")),
    ]
    with patch.object(graph, "load_mcp_tools", tools_returning(tools)):
        out = run(
            graph.act_node(state(messages=[AIMessage(content="", tool_calls=calls)]))
        )
    assert out["tool_results"] == [
        {"tool": "list_deployments", "output": "2 degraded"},
        {"tool": "does_not_exist", "error": "no such tool"},
        {"tool": "flaky", "error": "boom"},
    ]


def test_reflect_stops_at_the_iteration_limit_and_when_nothing_ran():
    assert (
        run(graph.reflect_node(state(iterations=graph.MAX_ITERATIONS)))["done"] is True
    )
    assert run(graph.reflect_node(state(tool_results=[])))["done"] is True
    assert (
        run(graph.reflect_node(state(tool_results=[{"tool": "a", "error": "x"}])))[
            "done"
        ]
        is True
    )
    assert (
        run(graph.reflect_node(state(tool_results=[{"tool": "a", "output": "ok"}])))[
            "done"
        ]
        is True
    )


def test_should_continue_routes_on_done():
    assert graph._should_continue(state(done=True)) == "respond"
    assert graph._should_continue(state(done=False)) == "select_tools"


def test_respond_answers_from_the_tool_observations():
    fake = FakeModel(reply="Two deployments are degraded.")
    results = [
        {"tool": "list_deployments", "output": "2 degraded"},
        {"tool": "flaky", "error": "boom"},
    ]
    with patch.object(graph, "_model", return_value=fake):
        out = run(graph.respond_node(state(tool_results=results)))
    assert out["done"] is True
    assert out["messages"][0].content == "Two deployments are degraded."
    observations = fake.prompts[0][-1].content
    assert "- list_deployments: 2 degraded" in observations
    assert "- flaky: boom" in observations


def test_respond_says_when_there_was_no_tool_output():
    fake = FakeModel()
    with patch.object(graph, "_model", return_value=fake):
        run(graph.respond_node(state()))
    assert "(no tool output)" in fake.prompts[0][-1].content


def test_run_agent_end_to_end_without_tools():
    fake = FakeModel(reply="No tools were available, so I cannot check deployments.")
    with patch.object(graph, "_model", return_value=fake), patch.object(
        graph, "load_mcp_tools", tools_returning([])
    ):
        out = run(graph.run_agent("Which deployments are unhealthy?", thread_id="t1"))
    assert out["answer"] == "No tools were available, so I cannot check deployments."
    assert out["tools_used"] == []
    assert out["iterations"] == 1
