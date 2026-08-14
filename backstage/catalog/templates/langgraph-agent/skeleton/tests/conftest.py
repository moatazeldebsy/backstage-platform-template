"""Shared fixtures.

The API key is set before `src.main` is imported anywhere, so `get_client()`
reaches the client-construction branch instead of raising 503. The Anthropic
client itself is replaced per-test — no test in this suite makes a network call
or spends a token.
"""

import os
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test-key-not-real")
# Leave LANGFUSE_OTLP_ENDPOINT unset: telemetry.py is a no-op without it, which
# is what we want in tests. The tracing path is exercised by the platform repo's
# own telemetry tests, not here.


@pytest.fixture
def fake_message():
    """A minimal stand-in for anthropic.types.Message.

    Only the attributes src.main actually reads are present — adding the rest
    would just be a second, staler copy of the SDK's model.
    """

    def _build(text="Hello from the model.", stop_reason="end_turn", model=None):
        from src import main

        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=text)] if text else [],
            stop_reason=stop_reason,
            model=model or main.MODEL,
            usage=SimpleNamespace(input_tokens=12, output_tokens=34),
        )

    return _build


@pytest.fixture
def mock_anthropic(monkeypatch, fake_message):
    """Patch the module-level client with a mock that returns `fake_message()`.

    Resets the cached client both before and after: `_client` is module state,
    so a test that leaves a mock in place would silently serve it to the next
    test.
    """
    from src import main

    client = MagicMock()
    client.messages.create.return_value = fake_message()

    monkeypatch.setattr(main, "_client", client)
    yield client
    main._client = None
