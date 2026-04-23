"""
FastAPI application for ${{ values.name }}.

Endpoints:
  GET  /healthz  — liveness probe
  GET  /ready    — readiness probe
  GET  /metrics  — Prometheus text format
  POST /invoke   — run the LangGraph agent and return the final message
"""
import json
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from langchain_core.messages import HumanMessage
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
from pydantic import BaseModel

import mlflow

from src.agent import GRAPH
from src.metrics import (
    AGENT_INVOCATIONS,
    AGENT_LATENCY,
    LLM_TOKEN_USAGE,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── MLflow setup ──────────────────────────────────────────────────────────────
MLFLOW_TRACKING_URI = os.getenv(
    "MLFLOW_TRACKING_URI",
    "http://mlflow.ml-platform.svc.cluster.local:5000",
)
MLFLOW_EXPERIMENT = os.getenv("MLFLOW_EXPERIMENT", "${{ values.name }}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    try:
        mlflow.set_experiment(MLFLOW_EXPERIMENT)
        logger.info(json.dumps({"msg": "MLflow experiment set", "experiment": MLFLOW_EXPERIMENT}))
    except Exception as exc:
        logger.warning(json.dumps({"msg": "MLflow unavailable — traces disabled", "error": str(exc)}))
    yield


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="${{ values.name }}",
    description="${{ values.description }}",
    version="0.1.0",
    lifespan=lifespan,
)


# ── Schemas ───────────────────────────────────────────────────────────────────
class InvokeRequest(BaseModel):
    message: str
    session_id: str | None = None


class InvokeResponse(BaseModel):
    output: str
    session_id: str | None = None
    run_id: str | None = None


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    return {"status": "ready"}


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    return PlainTextResponse(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST,
    )


@app.post("/invoke", response_model=InvokeResponse)
async def invoke(request: InvokeRequest):
    start = time.time()
    run_id: str | None = None

    with mlflow.start_run(run_name=request.session_id or "invoke") as run:
        run_id = run.info.run_id
        mlflow.log_param("session_id", request.session_id or "")
        mlflow.log_param("message_len", len(request.message))

        try:
            state = {"messages": [HumanMessage(content=request.message)]}
            result = GRAPH.invoke(state)

            final_message = result["messages"][-1]
            output = final_message.content

            # Log token usage if available from the LLM response
            usage = getattr(final_message, "usage_metadata", None) or {}
            prompt_tokens = usage.get("input_tokens", 0)
            completion_tokens = usage.get("output_tokens", 0)

            if prompt_tokens:
                LLM_TOKEN_USAGE.labels(token_type="prompt").inc(prompt_tokens)
                mlflow.log_metric("prompt_tokens", prompt_tokens)
            if completion_tokens:
                LLM_TOKEN_USAGE.labels(token_type="completion").inc(completion_tokens)
                mlflow.log_metric("completion_tokens", completion_tokens)

            latency = time.time() - start
            AGENT_LATENCY.observe(latency)
            AGENT_INVOCATIONS.labels(status="success").inc()
            mlflow.log_metric("latency_seconds", round(latency, 3))
            mlflow.log_param("output_len", len(output))

            logger.info(
                json.dumps({
                    "msg": "invoke complete",
                    "session_id": request.session_id,
                    "latency": round(latency, 3),
                    "run_id": run_id,
                })
            )

            return InvokeResponse(
                output=output,
                session_id=request.session_id,
                run_id=run_id,
            )

        except Exception as exc:
            latency = time.time() - start
            AGENT_LATENCY.observe(latency)
            AGENT_INVOCATIONS.labels(status="error").inc()
            mlflow.log_metric("latency_seconds", round(latency, 3))
            mlflow.set_tag("error", str(exc))
            logger.error(
                json.dumps({
                    "msg": "invoke error",
                    "session_id": request.session_id,
                    "error": str(exc),
                })
            )
            raise HTTPException(status_code=500, detail=str(exc)) from exc
