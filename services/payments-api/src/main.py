import logging
import json
import time
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from typing import Optional
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Payments API",
    description="Payment processing service — manages transactions, accounts, and payment operations",
    version="1.0.0",
    contact={"name": "platform-team"},
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


# --- Models ---

class Transaction(BaseModel):
    id: str
    amount: float
    currency: str
    status: str
    account_id: str

class Account(BaseModel):
    id: str
    owner: str
    balance: float
    currency: str

class PaymentRequest(BaseModel):
    amount: float
    currency: str
    account_id: str
    description: Optional[str] = None

class PaymentResponse(BaseModel):
    transaction_id: str
    status: str
    amount: float
    currency: str


# --- Health & Infra ---

@app.get("/healthz", tags=["infra"])
async def healthz():
    return {"status": "ok"}

@app.get("/ready", tags=["infra"])
async def ready():
    return {"status": "ready"}

@app.get("/metrics", response_class=PlainTextResponse, tags=["infra"])
async def metrics():
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# --- Payments API ---

@app.get(
    "/api/transactions",
    response_model=list[Transaction],
    tags=["payments"],
    summary="List recent transactions",
)
async def list_transactions(limit: int = 10):
    """Return the most recent transactions across all accounts."""
    return [
        {"id": "txn-001", "amount": 99.99, "currency": "USD", "status": "completed", "account_id": "acc-001"},
        {"id": "txn-002", "amount": 250.00, "currency": "USD", "status": "completed", "account_id": "acc-002"},
        {"id": "txn-003", "amount": 15.50, "currency": "EUR", "status": "pending", "account_id": "acc-001"},
    ][:limit]


@app.get(
    "/api/accounts/{account_id}",
    response_model=Account,
    tags=["payments"],
    summary="Get account details",
)
async def get_account(account_id: str):
    """Retrieve account details including current balance."""
    accounts = {
        "acc-001": {"id": "acc-001", "owner": "Alice Smith", "balance": 1250.00, "currency": "USD"},
        "acc-002": {"id": "acc-002", "owner": "Bob Jones", "balance": 3400.50, "currency": "USD"},
    }
    if account_id not in accounts:
        raise HTTPException(status_code=404, detail=f"Account {account_id} not found")
    return accounts[account_id]


@app.post(
    "/api/payments",
    response_model=PaymentResponse,
    status_code=201,
    tags=["payments"],
    summary="Process a new payment",
)
async def create_payment(payment: PaymentRequest):
    """Submit a payment request. Returns a transaction ID and initial status."""
    logger.info(json.dumps({"msg": "payment created", "amount": payment.amount, "currency": payment.currency}))
    return {
        "transaction_id": "txn-new-001",
        "status": "pending",
        "amount": payment.amount,
        "currency": payment.currency,
    }
