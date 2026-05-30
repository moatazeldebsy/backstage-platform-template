import logging
import json
import time
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="${{ values.name }}", description="${{ values.description }}")

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


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start
    endpoint = request.url.path
    REQUEST_DURATION.labels(method=request.method, endpoint=endpoint).observe(duration)
    REQUEST_COUNT.labels(
        method=request.method, endpoint=endpoint, status_code=str(response.status_code)
    ).inc()
    return response


@app.get("/healthz")
async def healthz():
    logger.info(json.dumps({"msg": "healthz ok"}))
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    return {"status": "ready"}


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/")
async def root():
    logger.info(json.dumps({"msg": "root called"}))
    return {"service": "${{ values.name }}", "status": "running"}
