"""
LangGraph agent for ${{ values.name }}.

Graph layout:
  START → agent_node → (tool_node if tool_calls) | END
                          ↑____________________________↓

The agent uses a ReAct-style loop: the LLM decides which tool to call,
the tool_node executes it, and the result is fed back to the LLM.
"""
import logging
import os
from typing import Annotated

from langchain_core.messages import BaseMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from typing_extensions import TypedDict

from src.tools import TOOLS
from src.metrics import TOOL_CALLS

logger = logging.getLogger(__name__)

# ── State ─────────────────────────────────────────────────────────────────────


class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]


# ── LLM factory ───────────────────────────────────────────────────────────────


def _build_llm():
    provider = os.getenv("LLM_PROVIDER", "${{ values.llmProvider }}")
    model = os.getenv("LLM_MODEL", "${{ values.llmModel }}")

    if provider == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(model=model, temperature=0)

    if provider == "stub":
        # Lightweight no-op LLM used only for smoke tests — no external connections
        from typing import Any, Iterator, List, Optional
        from langchain_core.language_models.chat_models import BaseChatModel
        from langchain_core.messages import AIMessage
        from langchain_core.outputs import ChatGeneration, ChatResult

        class _StubLLM(BaseChatModel):
            @property
            def _llm_type(self) -> str:
                return "stub"

            def _generate(self, messages, stop=None, run_manager=None, **kwargs):
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="stub"))])

            def bind_tools(self, tools, **kwargs):
                # Stub ignores tools; return self so LangGraph graph wiring succeeds
                return self

        return _StubLLM()

    # Default: Ollama (no API key, runs locally or via service)
    from langchain_ollama import ChatOllama
    ollama_base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    return ChatOllama(model=model, base_url=ollama_base_url, temperature=0)


# ── Instrumented tool node ────────────────────────────────────────────────────


class _InstrumentedToolNode(ToolNode):
    """Wraps ToolNode to count tool calls in Prometheus."""

    def invoke(self, state: AgentState, *args, **kwargs):
        messages = state.get("messages", [])
        if messages:
            last = messages[-1]
            for tc in getattr(last, "tool_calls", []):
                TOOL_CALLS.labels(tool_name=tc.get("name", "unknown")).inc()
        return super().invoke(state, *args, **kwargs)


# ── Graph builder ─────────────────────────────────────────────────────────────


def build_graph() -> StateGraph:
    llm = _build_llm()
    llm_with_tools = llm.bind_tools(TOOLS)

    def agent_node(state: AgentState) -> dict:
        response = llm_with_tools.invoke(state["messages"])
        return {"messages": [response]}

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", _InstrumentedToolNode(TOOLS))

    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition)
    graph.add_edge("tools", "agent")

    return graph.compile()


# Module-level compiled graph (loaded once at import time)
GRAPH = build_graph()
