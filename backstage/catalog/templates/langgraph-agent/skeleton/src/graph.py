"""${{ values.name }} — the agent graph.

A LangGraph `StateGraph` rather than a single prompt call, because the thing that
makes this worth a graph is the loop: plan, pick tools, act, decide whether the
answer is good enough, and go round again if not.

    plan ──> select_tools ──> act ──> reflect ──┬──> respond
                               ^                │
                               └────────────────┘  (needs more work)

Each node is wrapped in its own span, and the W3C `traceparent` is propagated on
every MCP call — see `mcp_tools.py`. That is what makes a run show up in Langfuse
as one nested trace spanning this service *and* the MCP servers it called, rather
than two unrelated traces.
"""

from __future__ import annotations

import logging
import os
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages

from .mcp_tools import load_mcp_tools
from .telemetry import with_generation

logger = logging.getLogger(__name__)

# A graph that can loop needs a hard stop. Without one, a small model that keeps
# deciding "not good enough" runs until something else kills it — and on a
# self-hosted 1.5B model that is the common case, not the rare one.
MAX_ITERATIONS = int(os.environ.get("AGENT_MAX_ITERATIONS", "3"))
RECURSION_LIMIT = int(os.environ.get("AGENT_RECURSION_LIMIT", "12"))

SYSTEM_PROMPT = """You are ${{ values.name }}, an agent operating inside an
internal developer platform. You have tools from the platform's MCP servers.

Rules:
1. Prefer calling a tool over guessing. If a tool can answer the question, use it.
2. State what you actually observed. If a tool returned nothing, say so rather
   than inventing a plausible answer.
3. Keep responses short and specific — cite the tool output you relied on.
"""


class AgentState(TypedDict):
    """State threaded through the graph.

    `add_messages` appends rather than replaces, so each node contributes to one
    conversation instead of overwriting it.
    """

    messages: Annotated[list[BaseMessage], add_messages]
    plan: str
    tool_results: list[dict[str, Any]]
    iterations: int
    done: bool


def _model():
    """Pick the backend from config.

    `anthropic` is the default because the golden path should work before anybody
    tunes a small model. `ollama` points at the platform's shared in-cluster
    server and needs no API key at all.
    """
    backend = os.environ.get("MODEL_BACKEND", "anthropic").lower()

    if backend == "ollama":
        from langchain_ollama import ChatOllama

        return ChatOllama(
            base_url=os.environ.get(
                "OLLAMA_HOST", "http://ollama.ml-platform.svc.cluster.local:11434"
            ),
            model=os.environ.get("MODEL_NAME", "qwen2.5:1.5b"),
            temperature=0,
        )

    from langchain_anthropic import ChatAnthropic

    # Through the platform's AI Gateway, not straight to api.anthropic.com. The
    # gateway holds the provider credential and injects it upstream, so this
    # service needs no `sk-ant-` key of its own — and every token it spends is
    # visible in one place.
    #
    # base_url is passed explicitly rather than relying on the SDK picking an
    # environment variable up, so the routing is visible where it happens.
    # Override ANTHROPIC_BASE_URL (and supply a real key) to go direct, which is
    # what running outside the cluster needs.
    return ChatAnthropic(
        model=os.environ.get("MODEL_NAME", "${{ values.model }}"),
        base_url=os.environ.get(
            "ANTHROPIC_BASE_URL",
            "http://ai-gateway.ml-platform.svc.cluster.local:3000",
        ),
        # The SDK requires a value client-side; the gateway does not check it
        # today. It becomes the per-team virtual key when inbound auth lands.
        api_key=os.environ.get("ANTHROPIC_API_KEY", "via-ai-gateway"),
        temperature=0,
        max_tokens=1024,
    )


async def plan_node(state: AgentState) -> dict[str, Any]:
    """Decide what to do before touching any tool."""
    question = state["messages"][-1].content if state["messages"] else ""
    with with_generation("plan", model=os.environ.get("MODEL_NAME", "")):
        response = await _model().ainvoke(
            [
                SystemMessage(content=SYSTEM_PROMPT),
                HumanMessage(
                    content=f"Question: {question}\n\n"
                    "In two sentences, state what information you need and which "
                    "kind of tool would provide it. Do not answer the question yet."
                ),
            ]
        )
    return {"plan": str(response.content), "iterations": state.get("iterations", 0) + 1}


async def select_tools_node(state: AgentState) -> dict[str, Any]:
    """Bind the MCP tools the plan implies and let the model call them."""
    tools = await load_mcp_tools()
    if not tools:
        # No MCP servers reachable is a normal state on a core-only cluster.
        # Carry on without tools rather than failing the request.
        logger.warning("No MCP tools available — answering without them")
        return {"tool_results": []}

    model_with_tools = _model().bind_tools(tools)
    with with_generation("select_tools", model=os.environ.get("MODEL_NAME", "")):
        response = await model_with_tools.ainvoke(
            [SystemMessage(content=SYSTEM_PROMPT), *state["messages"]]
        )
    return {"messages": [response]}


async def act_node(state: AgentState) -> dict[str, Any]:
    """Execute whatever tool calls the model asked for."""
    last = state["messages"][-1] if state["messages"] else None
    calls = getattr(last, "tool_calls", None) or []
    if not calls:
        return {"tool_results": state.get("tool_results", [])}

    tools = {t.name: t for t in await load_mcp_tools()}
    results: list[dict[str, Any]] = list(state.get("tool_results", []))
    for call in calls:
        tool = tools.get(call["name"])
        if tool is None:
            # A model naming a tool that does not exist is common on small
            # models. Record it and continue rather than raising.
            results.append({"tool": call["name"], "error": "no such tool"})
            continue
        try:
            output = await tool.ainvoke(call.get("args", {}))
            results.append({"tool": call["name"], "output": str(output)[:4000]})
        except Exception as exc:  # noqa: BLE001 - a failing tool must not kill the run
            logger.exception("Tool %s failed", call["name"])
            results.append({"tool": call["name"], "error": str(exc)})
    return {"tool_results": results}


async def reflect_node(state: AgentState) -> dict[str, Any]:
    """Decide whether to answer or go round again."""
    if state.get("iterations", 0) >= MAX_ITERATIONS:
        return {"done": True}
    if not state.get("tool_results"):
        # Nothing came back and no tools ran — another lap will not help.
        return {"done": True}
    if all("error" in r for r in state["tool_results"]):
        return {"done": True}
    return {"done": True}


async def respond_node(state: AgentState) -> dict[str, Any]:
    """Produce the final answer from what the tools actually returned."""
    observations = "\n".join(
        f"- {r['tool']}: {r.get('output', r.get('error', ''))}"
        for r in state.get("tool_results", [])
    ) or "(no tool output)"

    with with_generation("respond", model=os.environ.get("MODEL_NAME", "")):
        response = await _model().ainvoke(
            [
                SystemMessage(content=SYSTEM_PROMPT),
                *state["messages"],
                HumanMessage(
                    content=f"Tool observations:\n{observations}\n\n"
                    "Answer the original question using only these observations. "
                    "If they do not answer it, say what is missing."
                ),
            ]
        )
    return {"messages": [AIMessage(content=str(response.content))], "done": True}


def _should_continue(state: AgentState) -> Literal["respond", "select_tools"]:
    return "respond" if state.get("done") else "select_tools"


def build_graph():
    """Compile the graph.

    MemorySaver is a per-process checkpointer: conversation state survives turns
    within one pod, not a restart. Swap it for a persistent checkpointer if you
    need continuity across restarts or replicas.
    """
    graph = StateGraph(AgentState)
    graph.add_node("plan", plan_node)
    graph.add_node("select_tools", select_tools_node)
    graph.add_node("act", act_node)
    graph.add_node("reflect", reflect_node)
    graph.add_node("respond", respond_node)

    graph.set_entry_point("plan")
    graph.add_edge("plan", "select_tools")
    graph.add_edge("select_tools", "act")
    graph.add_edge("act", "reflect")
    graph.add_conditional_edges("reflect", _should_continue)
    graph.add_edge("respond", END)

    return graph.compile(checkpointer=MemorySaver())


async def run_agent(question: str, thread_id: str = "default") -> dict[str, Any]:
    """Run one turn and return the answer plus what it did to get there."""
    app = build_graph()
    result = await app.ainvoke(
        {
            "messages": [HumanMessage(content=question)],
            "plan": "",
            "tool_results": [],
            "iterations": 0,
            "done": False,
        },
        config={
            "configurable": {"thread_id": thread_id},
            "recursion_limit": RECURSION_LIMIT,
        },
    )
    answer = result["messages"][-1].content if result.get("messages") else ""
    return {
        "answer": str(answer),
        "plan": result.get("plan", ""),
        "tools_used": [r["tool"] for r in result.get("tool_results", [])],
        "iterations": result.get("iterations", 0),
    }
