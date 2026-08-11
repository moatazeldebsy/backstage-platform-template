"""${{ values.name }} — ${{ values.description }}

A Claude-backed chat endpoint with Langfuse tracing wired in. Scaffolded by the
IDP `llm-app-langfuse` template.
"""

import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Literal, cast

import anthropic
from anthropic.types import OutputConfigParam
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from pydantic import BaseModel, Field

from .telemetry import (
    init_tracing,
    record_usage,
    shutdown_tracing,
    tracing_enabled,
    with_generation,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger(__name__)

SERVICE_NAME = "${{ values.name }}"

# Chosen at scaffold time. Model ids carry no date suffix — `claude-opus-5` is
# the complete id, not a prefix to extend.
MODEL = os.environ.get("ANTHROPIC_MODEL", "${{ values.model }}")

# How much the model thinks before answering. Raise it for hard reasoning, lower
# it for latency-sensitive endpoints. This is the lever to reach for before
# adding "think carefully" to a prompt.
#
# Validated rather than passed through: an unrecognised value here would be a
# 400 from the API on the first real request, which is a bad way to find out
# about a typo in a Helm values file.
EffortLevel = Literal["low", "medium", "high", "xhigh", "max"]
_EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")
_effort_raw = os.environ.get("ANTHROPIC_EFFORT", "${{ values.effort }}")
if _effort_raw not in _EFFORT_LEVELS:
    logger.warning(
        json.dumps(
            {"msg": "unknown ANTHROPIC_EFFORT, falling back", "value": _effort_raw}
        )
    )
EFFORT: EffortLevel = cast(
    EffortLevel, _effort_raw if _effort_raw in _EFFORT_LEVELS else "medium"
)

# Bounds thinking + response text together. Sized for a chat reply; raise it if
# you raise EFFORT, or responses will truncate mid-answer.
MAX_TOKENS = int(os.environ.get("ANTHROPIC_MAX_TOKENS", "8192"))

SYSTEM_PROMPT = os.environ.get(
    "SYSTEM_PROMPT",
    "You are a helpful assistant. Answer concisely and say so when you are unsure.",
)

# Created once at import. The client is thread-safe and holds a connection pool;
# building one per request throws that pool away on every call.
_client: anthropic.Anthropic | None = None


def get_client() -> anthropic.Anthropic:
    """Return the shared Anthropic client, or 503 if the API key is missing.

    The key comes from `secret/${{ values.name }}-secrets`, which is mounted
    with `optional: true` — the pod starts without it so a missing secret is a
    degraded endpoint rather than a crashloop. See the README.
    """
    global _client
    if _client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise HTTPException(
                status_code=503,
                detail=(
                    "ANTHROPIC_API_KEY is not set. Create secret/"
                    "${{ values.name }}-secrets in this namespace — see the README."
                ),
            )
        _client = anthropic.Anthropic()
    return _client


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_tracing(SERVICE_NAME)
    logger.info(
        json.dumps({"msg": "startup", "model": MODEL, "tracing": tracing_enabled()})
    )
    yield
    # Flush buffered spans — without this the last few calls before a pod
    # termination never reach Langfuse.
    shutdown_tracing()


app = FastAPI(
    title=SERVICE_NAME,
    description="${{ values.description }}",
    lifespan=lifespan,
)

REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status_code"],
)

REQUEST_DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["method", "endpoint"],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
)

# Model calls are seconds-to-minutes, not milliseconds — the HTTP buckets above
# would put every one of them in the overflow bucket.
LLM_DURATION = Histogram(
    "llm_request_duration_seconds",
    "Model call duration in seconds",
    ["model"],
    buckets=[0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
)

LLM_TOKENS = Counter(
    "llm_tokens_total",
    "Tokens consumed by model calls",
    ["model", "direction"],
)


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    endpoint = request.url.path
    REQUEST_DURATION.labels(method=request.method, endpoint=endpoint).observe(
        time.time() - start
    )
    REQUEST_COUNT.labels(
        method=request.method, endpoint=endpoint, status_code=str(response.status_code)
    ).inc()
    return response


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=100_000)
    # Optional identifiers. Both are recorded on the Langfuse span, which is what
    # makes per-user and per-conversation views work in the Langfuse UI.
    user_id: str | None = None
    session_id: str | None = None


class ChatResponse(BaseModel):
    reply: str
    model: str
    input_tokens: int
    output_tokens: int


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    client = get_client()

    output_config: OutputConfigParam = {"effort": EFFORT}

    def call_model() -> Any:
        # No temperature / top_p / top_k: current models reject them outright.
        # Steer behaviour through SYSTEM_PROMPT and EFFORT instead.
        return client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            output_config=output_config,
            messages=[{"role": "user", "content": req.message}],
        )

    started = time.time()
    try:
        # Wraps the call in a Langfuse `generation` observation. Prompt and
        # completion are only recorded when LANGFUSE_CAPTURE_IO=true.
        message = with_generation(
            "chat",
            call_model,
            model=MODEL,
            input=req.message,
            user_id=req.user_id,
            session_id=req.session_id,
        )
    except anthropic.APIStatusError as exc:
        logger.warning(
            json.dumps({"msg": "model call failed", "status": exc.status_code})
        )
        # 429 and 5xx are worth retrying upstream; 4xx are not. Pass the
        # distinction through rather than flattening everything to 500.
        status = (
            exc.status_code
            if exc.status_code in (429,) or exc.status_code >= 500
            else 502
        )
        raise HTTPException(status_code=status, detail="model call failed") from exc
    except anthropic.APIConnectionError as exc:
        raise HTTPException(
            status_code=503, detail="could not reach the model API"
        ) from exc

    LLM_DURATION.labels(model=MODEL).observe(time.time() - started)

    # Safety classifiers can decline a request: HTTP 200 with stop_reason
    # "refusal" and an empty content list. Reading content[0] unconditionally
    # would raise IndexError here, so check stop_reason first.
    if message.stop_reason == "refusal":
        logger.info(json.dumps({"msg": "model refused the request"}))
        raise HTTPException(status_code=422, detail="the model declined this request")

    usage = message.usage
    # Langfuse computes cost from these plus the model id — a generation span
    # without them shows latency but no cost.
    record_usage(usage.input_tokens, usage.output_tokens)
    LLM_TOKENS.labels(model=MODEL, direction="input").inc(usage.input_tokens)
    LLM_TOKENS.labels(model=MODEL, direction="output").inc(usage.output_tokens)

    reply = "".join(block.text for block in message.content if block.type == "text")

    return ChatResponse(
        reply=reply,
        model=message.model,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
    )


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    # Deliberately does NOT call the model API: a readiness probe that costs a
    # token per check would bill continuously and fail the pod on a provider
    # blip. It reports whether this process is configured, nothing more.
    return {
        "status": "ready",
        "model": MODEL,
        "api_key_configured": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "tracing_enabled": tracing_enabled(),
    }


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/")
async def root():
    return {"service": SERVICE_NAME, "status": "running", "model": MODEL}
