"""Contract tests for the disabled-by-default behaviour of src/telemetry.py.

The module ships from the platform with tracing OFF unless LANGFUSE_OTLP_ENDPOINT
is set, and everything downstream depends on that: it is what makes the service
safe to deploy before Langfuse credentials reach the namespace, and what stops a
Langfuse outage from breaking request serving. These tests pin that contract.

The enabled path (exporter setup, span attributes) needs an OTLP collector to
assert against and is covered in the platform repo, not here — see .coveragerc.
"""

import pytest

from src import telemetry


def test_tracing_disabled_without_endpoint():
    # conftest.py deliberately leaves LANGFUSE_OTLP_ENDPOINT unset.
    telemetry.init_tracing("demo-llm-app")
    assert telemetry.tracing_enabled() is False


def test_with_generation_calls_through_when_disabled():
    assert telemetry.with_generation("chat", lambda: "result", model="m") == "result"


def test_with_generation_propagates_exceptions_when_disabled():
    def boom():
        raise ValueError("upstream failed")

    # The wrapper must not swallow or wrap errors — callers rely on catching the
    # provider's own exception types.
    with pytest.raises(ValueError, match="upstream failed"):
        telemetry.with_generation("chat", boom)


def test_record_usage_is_a_noop_when_disabled():
    telemetry.record_usage(10, 20)  # must not raise without an active span


def test_shutdown_is_a_noop_when_disabled():
    telemetry.shutdown_tracing()  # must not raise without a provider


def test_clip_truncates_at_the_documented_limit():
    clipped = telemetry._clip("x" * (telemetry.MAX_IO_CHARS + 500))
    assert clipped.endswith("...[truncated]")
    assert len(clipped) == telemetry.MAX_IO_CHARS + len("...[truncated]")


def test_clip_serialises_non_strings():
    assert telemetry._clip({"a": 1}) == '{"a": 1}'


def test_clip_falls_back_to_str_for_unserialisable_values():
    class Unserialisable:
        def __repr__(self):
            return "<unserialisable>"

    # default=str inside _clip handles this rather than raising — a captured
    # value that cannot be JSON-encoded must not fail the request.
    assert "unserialisable" in telemetry._clip(Unserialisable())
