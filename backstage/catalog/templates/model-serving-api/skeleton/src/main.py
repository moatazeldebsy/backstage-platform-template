import logging
import json
import os
from typing import Any
from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Prometheus metrics ────────────────────────────────────────────────────────
REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status"],
)
PREDICTION_LATENCY = Histogram(
    "prediction_latency_seconds",
    "Time spent serving a /v1/predict request",
    buckets=[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5],
)
PREDICTION_COUNT = Counter(
    "predictions_total",
    "Total predictions served",
    ["outcome"],
)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="${{ values.name }}",
    description="${{ values.description }}",
    version="0.1.0",
)

# ── Model loading ─────────────────────────────────────────────────────────────
MODEL = None
MLFLOW_TRACKING_URI = os.getenv("MLFLOW_TRACKING_URI", "http://mlflow.ml-platform.svc.cluster.local:5000")
MODEL_URI = os.getenv("MODEL_URI", "")  # e.g. models:/<name>/Production or runs:/<run-id>/model


def load_model():
    """Load model from MLflow at startup. Falls back to a stub if MODEL_URI is not set."""
    global MODEL
    if not MODEL_URI:
        logger.warning(json.dumps({"msg": "MODEL_URI not set — using stub predictor"}))
        return

    import mlflow
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    try:
        MODEL = mlflow.pyfunc.load_model(MODEL_URI)
        logger.info(json.dumps({"msg": "model loaded", "uri": MODEL_URI}))
    except Exception as exc:
        logger.error(json.dumps({"msg": "model load failed", "error": str(exc)}))


@app.on_event("startup")
async def startup():
    load_model()


# ── Request / Response schemas ────────────────────────────────────────────────
class PredictRequest(BaseModel):
    inputs: list[Any]
    params: dict[str, Any] | None = None


class PredictResponse(BaseModel):
    predictions: list[Any]


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.post("/v1/predict", response_model=PredictResponse)
async def predict(request: PredictRequest):
    start = time.time()
    try:
        if MODEL is None:
            # Stub: echo back inputs (useful for local dev before a real model is loaded)
            predictions = request.inputs
        else:
            import pandas as pd
            df = pd.DataFrame(request.inputs)
            predictions = MODEL.predict(df).tolist()

        duration = time.time() - start
        PREDICTION_LATENCY.observe(duration)
        PREDICTION_COUNT.labels(outcome="success").inc()
        REQUEST_COUNT.labels(method="POST", endpoint="/v1/predict", status="200").inc()

        logger.info(json.dumps({
            "msg": "prediction served",
            "n": len(predictions),
            "latency_ms": round(duration * 1000, 2),
        }))
        return PredictResponse(predictions=predictions)

    except Exception as exc:
        PREDICTION_COUNT.labels(outcome="error").inc()
        REQUEST_COUNT.labels(method="POST", endpoint="/v1/predict", status="500").inc()
        logger.error(json.dumps({"msg": "prediction failed", "error": str(exc)}))
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/healthz")
async def healthz():
    REQUEST_COUNT.labels(method="GET", endpoint="/healthz", status="200").inc()
    logger.info(json.dumps({"msg": "healthz ok"}))
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    REQUEST_COUNT.labels(method="GET", endpoint="/ready", status="200").inc()
    return {"status": "ready"}


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/")
async def root():
    REQUEST_COUNT.labels(method="GET", endpoint="/", status="200").inc()
    return {"service": "${{ values.name }}", "status": "running", "model_loaded": MODEL is not None}
