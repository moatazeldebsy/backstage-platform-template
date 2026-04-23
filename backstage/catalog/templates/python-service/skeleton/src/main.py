import logging
import json
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from prometheus_client import Counter, generate_latest, CONTENT_TYPE_LATEST

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="${{ values.name }}", description="${{ values.description }}")

REQUEST_COUNT = Counter("http_requests_total", "Total HTTP requests", ["method", "endpoint"])


@app.get("/healthz")
async def healthz():
    logger.info(json.dumps({"msg": "healthz ok"}))
    REQUEST_COUNT.labels(method="GET", endpoint="/healthz").inc()
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    REQUEST_COUNT.labels(method="GET", endpoint="/ready").inc()
    return {"status": "ready"}


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/")
async def root():
    REQUEST_COUNT.labels(method="GET", endpoint="/").inc()
    logger.info(json.dumps({"msg": "root called"}))
    return {"service": "${{ values.name }}", "status": "running"}
