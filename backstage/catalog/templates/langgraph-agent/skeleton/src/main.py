"""${{ values.name }} — ${{ values.description }}

A LangGraph agent behind a FastAPI endpoint, scaffolded by the IDP
`langgraph-agent` template.

Where this sits relative to KAgent: KAgent runs *declarative* agents defined as
Kubernetes resources and owned by the platform team. This is an *imperative*
agent — an application you own, with branching and state you control in code.
Both consume the same MCP servers and both trace to the same Langfuse.
"""

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from pydantic import BaseModel, Field

from .graph import run_agent
from .mcp_tools import current_trace_id, load_mcp_tools
from .telemetry import init_tracing, shutdown_tracing, tracing_enabled

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger(__name__)

AGENT_RUNS = Counter(
    "agent_runs_total", "Agent runs", ["service", "outcome"]
)
AGENT_LATENCY = Histogram(
    "agent_run_duration_seconds", "Agent run duration", ["service"]
)
SERVICE = os.environ.get("OTEL_SERVICE_NAME", "${{ values.name }}")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_tracing()
    # Warm the tool cache so the first request does not pay session negotiation
    # with every MCP server. Failure here is not fatal — load_mcp_tools degrades.
    await load_mcp_tools()
    yield
    shutdown_tracing()


app = FastAPI(title="${{ values.name }}", lifespan=lifespan)


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    thread_id: str = Field("default", max_length=128)


class AskResponse(BaseModel):
    answer: str
    plan: str
    tools_used: list[str]
    iterations: int
    trace_id: str


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> dict[str, object]:
    # Ready even with no tools: a core-only cluster has no MCP servers and the
    # agent still answers. Reporting not-ready would keep the pod out of service
    # for a condition that is not an error.
    tools = await load_mcp_tools()
    return {"status": "ready", "mcp_tools": len(tools), "tracing": tracing_enabled()}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> AskResponse:
    with AGENT_LATENCY.labels(SERVICE).time():
        try:
            result = await run_agent(req.question, req.thread_id)
        except Exception as exc:  # noqa: BLE001 - surfaced as a 500 with a trace id
            AGENT_RUNS.labels(SERVICE, "error").inc()
            logger.exception("Agent run failed")
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    AGENT_RUNS.labels(SERVICE, "success").inc()
    return AskResponse(
        answer=result["answer"],
        plan=result["plan"],
        tools_used=result["tools_used"],
        iterations=result["iterations"],
        # Returned so a caller can find this exact run in Langfuse.
        trace_id=current_trace_id(),
    )
