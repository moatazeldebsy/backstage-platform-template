"""MCP tool loading: where tools come from, and that unreachable servers degrade.

A core-only cluster has no MCP servers at all, so every failure path here must
end in "no tools", never in an exception that fails the user's request.
"""

import asyncio
import sys
import types

import pytest

from src import mcp_tools


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    monkeypatch.setattr(mcp_tools, "_TOOLS_CACHE", None)


def fake_client_module(monkeypatch, get_tools):
    """Install a stand-in for langchain_mcp_adapters.client."""
    seen = {}

    class MultiServerMCPClient:
        def __init__(self, connections):
            seen["connections"] = connections

        async def get_tools(self):
            return await get_tools()

    pkg = types.ModuleType("langchain_mcp_adapters")
    mod = types.ModuleType("langchain_mcp_adapters.client")
    mod.MultiServerMCPClient = MultiServerMCPClient
    pkg.client = mod
    monkeypatch.setitem(sys.modules, "langchain_mcp_adapters", pkg)
    monkeypatch.setitem(sys.modules, "langchain_mcp_adapters.client", mod)
    return seen


def test_default_endpoint_is_the_ai_gateway(monkeypatch):
    monkeypatch.delenv("MCP_SERVERS", raising=False)
    monkeypatch.delenv("MCP_GATEWAY_NAMESPACE", raising=False)
    assert mcp_tools._endpoints() == {
        "platform": "http://ai-gateway.ml-platform.svc.cluster.local:3000/mcp"
    }


def test_mcp_servers_override_is_parsed_and_malformed_pairs_are_skipped(monkeypatch):
    monkeypatch.setenv(
        "MCP_SERVERS", "idp = http://idp:8080/mcp,garbage,qa=http://qa:8080/mcp"
    )
    assert mcp_tools._endpoints() == {
        "idp": "http://idp:8080/mcp",
        "qa": "http://qa:8080/mcp",
    }


def test_trace_headers_is_a_plain_dict():
    assert isinstance(mcp_tools._trace_headers(), dict)


def test_loads_tools_from_every_endpoint_and_caches_them(monkeypatch):
    monkeypatch.setenv("MCP_SERVERS", "idp=http://idp:8080/mcp")
    calls = {"n": 0}

    async def get_tools():
        calls["n"] += 1
        return ["tool-a", "tool-b"]

    seen = fake_client_module(monkeypatch, get_tools)
    assert asyncio.run(mcp_tools.load_mcp_tools()) == ["tool-a", "tool-b"]
    assert seen["connections"]["idp"]["url"] == "http://idp:8080/mcp"
    assert seen["connections"]["idp"]["transport"] == "streamable_http"
    # Second call is served from the cache — no new session with the servers.
    assert asyncio.run(mcp_tools.load_mcp_tools()) == ["tool-a", "tool-b"]
    assert calls["n"] == 1


def test_unreachable_servers_mean_no_tools_not_an_error(monkeypatch):
    async def get_tools():
        raise ConnectionError("connection refused")

    fake_client_module(monkeypatch, get_tools)
    assert asyncio.run(mcp_tools.load_mcp_tools()) == []


def test_missing_adapter_library_means_no_tools(monkeypatch):
    # A None entry in sys.modules makes the import raise ImportError.
    monkeypatch.setitem(sys.modules, "langchain_mcp_adapters.client", None)
    assert asyncio.run(mcp_tools.load_mcp_tools()) == []


def test_current_trace_id_is_a_hex_string():
    trace_id = mcp_tools.current_trace_id()
    assert isinstance(trace_id, str)
    int(trace_id or "0", 16)
