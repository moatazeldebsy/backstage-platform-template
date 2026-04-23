#!/usr/bin/env python3
"""
Backstage Catalog Exporter for Prometheus

Queries the Backstage catalog API for all Component entities of type 'service'
and exposes them as a Prometheus gauge metric pushed to a Pushgateway.

This enables Grafana to dynamically sync dashboard variables with the live
Backstage catalog — new services appear in Grafana drop-downs automatically.

Metric emitted:
  backstage_catalog_service_info{name, team, owner, lifecycle, system, cost_center}=1

Environment variables:
  BACKSTAGE_URL      — Backstage base URL (default: http://backstage:7007)
  PUSHGATEWAY_URL    — Prometheus Pushgateway endpoint
  BACKSTAGE_TOKEN    — Optional: Backstage static token for auth (leave unset for guest)
  POLL_INTERVAL      — Seconds between polls when running in --watch mode (default: 300)
"""
import os
import sys
import time
import logging

import requests
from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

BACKSTAGE_URL   = os.environ.get("BACKSTAGE_URL", "http://backstage:7007")
PUSHGATEWAY_URL = os.environ.get(
    "PUSHGATEWAY_URL",
    "http://prometheus-pushgateway.monitoring.svc.cluster.local:9091",
)
BACKSTAGE_TOKEN = os.environ.get("BACKSTAGE_TOKEN", "")
POLL_INTERVAL   = int(os.environ.get("POLL_INTERVAL", "300"))

CATALOG_API = (
    f"{BACKSTAGE_URL}/api/catalog/entities"
    "?filter=kind=Component"
    "&fields=metadata.name,metadata.annotations,spec.owner,spec.lifecycle,spec.system,spec.type"
)


def build_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if BACKSTAGE_TOKEN:
        headers["Authorization"] = f"Bearer {BACKSTAGE_TOKEN}"
    return headers


def fetch_catalog_services() -> list[dict]:
    """Fetch all Component entities from Backstage catalog, paginated."""
    entities = []
    url = CATALOG_API
    headers = build_headers()

    while url:
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        if isinstance(data, list):
            entities.extend(data)
            url = None  # no pagination on simple list response
        elif isinstance(data, dict) and "items" in data:
            entities.extend(data["items"])
            # Backstage cursor-based pagination
            cursor = data.get("pageInfo", {}).get("nextCursor")
            if cursor:
                url = f"{BACKSTAGE_URL}/api/catalog/entities?cursor={cursor}"
            else:
                url = None
        else:
            break

    # Filter to service-type components only (also includes websites, libraries, etc.)
    services = [e for e in entities if e.get("spec", {}).get("type") in ("service", "website")]
    log.info("Fetched %d service/website components from Backstage catalog", len(services))
    return services


def push_metrics(services: list[dict]) -> None:
    registry = CollectorRegistry()
    info_gauge = Gauge(
        "backstage_catalog_service_info",
        "Backstage catalog service registry — value is always 1; use labels for grouping",
        labelnames=["name", "owner", "lifecycle", "system", "cost_center"],
        registry=registry,
    )

    for entity in services:
        meta        = entity.get("metadata", {})
        spec        = entity.get("spec", {})
        annotations = meta.get("annotations", {})

        name        = meta.get("name", "unknown")
        owner       = spec.get("owner", "unknown")
        lifecycle   = spec.get("lifecycle", "unknown")
        system      = spec.get("system", "unknown")
        cost_center = annotations.get("cost-center", "unknown")

        info_gauge.labels(
            name=name,
            owner=owner,
            lifecycle=lifecycle,
            system=system,
            cost_center=cost_center,
        ).set(1)
        log.debug("Registered service: %s (owner=%s lifecycle=%s)", name, owner, lifecycle)

    push_to_gateway(
        PUSHGATEWAY_URL,
        job="backstage-catalog-exporter",
        registry=registry,
    )
    log.info("Pushed %d service metrics to Pushgateway at %s", len(services), PUSHGATEWAY_URL)


def run_once() -> None:
    services = fetch_catalog_services()
    push_metrics(services)


if __name__ == "__main__":
    watch_mode = "--watch" in sys.argv
    if watch_mode:
        log.info("Watch mode — polling every %ds", POLL_INTERVAL)
        while True:
            try:
                run_once()
            except Exception as exc:  # noqa: BLE001
                log.error("Export cycle failed: %s", exc)
            time.sleep(POLL_INTERVAL)
    else:
        run_once()
