"""Langfuse / OpenTelemetry tracing for LLM calls.

Scaffolded by the IDP platform. This file carries no template variables, so the
copy shipped by `enable-langfuse-tracing` and the one in the `llm-app-langfuse`
skeleton are byte-identical and can be diffed directly.

Install::

    pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http

Use (adjust the import to wherever this file landed — `langfuse.telemetry` when
added by the addon template, `src.telemetry` in the llm-app skeleton)::

    from langfuse.telemetry import init_tracing, with_generation, shutdown_tracing

    init_tracing("my-service")            # once, at startup

    reply = with_generation(
        "chat",
        lambda: call_the_model(user_message),
        model=model_id,
        input=user_message,
    )

Design notes
------------
- Raw OpenTelemetry, not the Langfuse SDK. The SDK depends on the same OTEL
  packages and its only real addition is a span processor that sets a static
  auth header, which is three lines here. Plain OTEL also produces the same span
  envelope as KAgent, so agent -> service traces nest correctly.

- Disabled by default. With LANGFUSE_OTLP_ENDPOINT unset, init_tracing() returns
  immediately and with_generation() just calls through: no provider, no
  exporter, zero overhead. That is what makes it safe to deploy this before the
  namespace has the credentials.

- The langfuse.* attribute keys are what Langfuse's OTLP ingest maps onto its
  own trace/observation model. Renaming them makes the span arrive as an untyped
  span with no cost or token accounting.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any, Callable, Mapping, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Read once at import. Changing these needs a process restart, which is what
# `kubectl rollout restart` after the key distribution does anyway.
_ENDPOINT = os.environ.get("LANGFUSE_OTLP_ENDPOINT", "")
_PUBLIC_KEY = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
_SECRET_KEY = os.environ.get("LANGFUSE_SECRET_KEY", "")
_CAPTURE_IO = os.environ.get("LANGFUSE_CAPTURE_IO", "false").lower() == "true"

try:
    _SAMPLE_RATE = float(os.environ.get("LANGFUSE_SAMPLE_RATE", "1.0"))
except ValueError:
    _SAMPLE_RATE = 1.0

# Hard cap on any single captured input/output attribute.
MAX_IO_CHARS = 8_000

_provider: Any = None
_enabled = False
_service_tag = "unknown-service"


def tracing_enabled() -> bool:
    """True when tracing is configured AND usable."""
    return _enabled


def init_tracing(service_name: str) -> None:
    """Set up the tracer provider.

    Safe to call more than once; only the first call does anything. Never
    raises — a misconfigured tracing backend must not stop the service from
    serving traffic.
    """
    global _provider, _enabled, _service_tag

    _service_tag = os.environ.get("OTEL_SERVICE_NAME") or service_name
    if _provider is not None or not _ENDPOINT:
        return

    if not _PUBLIC_KEY or not _SECRET_KEY:
        logger.warning(
            "LANGFUSE_OTLP_ENDPOINT is set but LANGFUSE_PUBLIC_KEY/"
            "LANGFUSE_SECRET_KEY are missing - tracing stays disabled."
        )
        return

    try:
        # Imported lazily so a deployment without the OTEL packages installed
        # still starts (untraced) rather than failing at import time.
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.trace.sampling import (
            ParentBased,
            TraceIdRatioBased,
        )

        # Langfuse authenticates OTLP ingest with HTTP Basic over the project
        # key pair. Set explicitly rather than through OTEL_EXPORTER_OTLP_HEADERS
        # so the two can never disagree.
        auth = base64.b64encode(f"{_PUBLIC_KEY}:{_SECRET_KEY}".encode("utf-8")).decode(
            "ascii"
        )

        exporter = OTLPSpanExporter(
            # An explicit full URL, deliberately NOT OTEL_EXPORTER_OTLP_ENDPOINT:
            # that variable is a *base* onto which the exporter appends
            # /v1/traces, while Langfuse documents a complete path. Mixing the
            # two yields .../api/public/otel/v1/traces/v1/traces and a silent 404.
            endpoint=_ENDPOINT,
            headers={"Authorization": f"Basic {auth}"},
        )

        _provider = TracerProvider(
            resource=Resource.create({"service.name": _service_tag}),
            # Parent-based so a sampled upstream trace keeps its child spans:
            # dropping a child of a sampled parent leaves a hole in the
            # waterfall.
            sampler=ParentBased(root=TraceIdRatioBased(_SAMPLE_RATE)),
        )
        _provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(_provider)
        _enabled = True
        logger.info("Langfuse tracing enabled -> %s", _ENDPOINT)
    except Exception:  # noqa: BLE001 - tracing must never break the service
        logger.warning(
            "Failed to initialise tracing - continuing without it", exc_info=True
        )
        _provider = None
        _enabled = False


def shutdown_tracing() -> None:
    """Flush buffered spans on shutdown.

    The batch processor holds spans for up to its scheduled delay, so without
    this the last few calls before a pod termination are lost. TracerProvider
    takes its export timeout from OTEL_BSP_EXPORT_TIMEOUT (30s by default), so
    set that if a hung collector is delaying your SIGTERM handling.
    """
    global _provider
    if _provider is None:
        return
    try:
        _provider.shutdown()
    except Exception:  # noqa: BLE001 - shutting down anyway
        pass
    finally:
        _provider = None


def _clip(value: Any) -> str:
    try:
        text = value if isinstance(value, str) else json.dumps(value, default=str)
    except (TypeError, ValueError):
        text = str(value)
    if len(text) > MAX_IO_CHARS:
        return text[:MAX_IO_CHARS] + "...[truncated]"
    return text


def with_generation(
    name: str,
    fn: Callable[[], T],
    *,
    model: str | None = None,
    input: Any = None,  # noqa: A002 - matches the Langfuse field name
    user_id: str | None = None,
    session_id: str | None = None,
    attributes: Mapping[str, Any] | None = None,
) -> T:
    """Wrap one model call in a Langfuse ``generation`` observation.

    Returns exactly what ``fn`` returns and re-raises whatever it raises, so it
    can be dropped around an existing call without changing control flow.

    ``input`` and the return value are only recorded when LANGFUSE_CAPTURE_IO is
    true.
    """
    if not _enabled:
        return fn()

    from opentelemetry import trace
    from opentelemetry.trace import SpanKind, StatusCode

    tracer = trace.get_tracer(_service_tag)
    with tracer.start_as_current_span(name, kind=SpanKind.CLIENT) as span:
        span.set_attribute("langfuse.observation.type", "generation")
        span.set_attribute("langfuse.trace.name", f"{_service_tag}.{name}")
        # The tag the Backstage Langfuse tab filters on. Keep it equal to the
        # `langfuse.com/service-name` annotation in catalog-info.yaml.
        span.set_attribute("langfuse.trace.tags", _service_tag)
        if model:
            span.set_attribute("gen_ai.request.model", model)
        if user_id:
            span.set_attribute("langfuse.user.id", user_id)
        if session_id:
            span.set_attribute("langfuse.session.id", session_id)
        for key, value in (attributes or {}).items():
            span.set_attribute(key, value)
        if _CAPTURE_IO and input is not None:
            span.set_attribute("langfuse.observation.input", _clip(input))

        try:
            result = fn()
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(StatusCode.ERROR, str(exc))
            raise
        if _CAPTURE_IO:
            span.set_attribute("langfuse.observation.output", _clip(result))
        return result


def record_usage(input_tokens: int, output_tokens: int) -> None:
    """Report token usage on the active generation span.

    Langfuse computes cost from these plus the model id, so a generation span
    without them shows latency but no cost. Call inside the ``with_generation``
    callback, once the provider response is in hand.
    """
    if not _enabled:
        return

    from opentelemetry import trace

    span = trace.get_current_span()
    if span is None:
        return
    span.set_attribute("gen_ai.usage.input_tokens", input_tokens)
    span.set_attribute("gen_ai.usage.output_tokens", output_tokens)
