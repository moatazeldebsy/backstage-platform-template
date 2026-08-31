#!/usr/bin/env python3
"""
Build the platform planes diagram.

Fetches each project's logo from its upstream home, inlines them into
`platform-planes.html`, and writes a self-contained page ready to screenshot.

The marks are deliberately NOT vendored into this repository. They are the
trademarks of their respective owners, used here only to identify the components
they belong to; fetching them at build time keeps that boundary clear and keeps
the marks current if a project rebrands.

Usage:

    python3 docs/diagrams/build-platform-planes.py
    # -> docs/diagrams/.build/platform-planes.built.html

    # then render it (playwright is already a dev dependency of the app):
    cd backstage/app && node ../../docs/diagrams/render.mjs \\
        ../../docs/diagrams/.build/platform-planes.built.html \\
        ../../docs/assets/platform-planes.png

Requires only the standard library plus network access.
"""

import base64
import json
import pathlib
import re
import sys
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = HERE / "platform-planes.html"
BUILD = HERE / ".build"

CNCF = "https://raw.githubusercontent.com/cncf/artwork/main/projects"
SIMPLE = "https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons"
GH = "https://raw.githubusercontent.com"

# slug -> URL. CNCF marks are full colour; simple-icons are single-path and get
# tinted to the brand's own published hex below.
SOURCES = {
    "backstage":     f"{CNCF}/backstage/icon/color/backstage-icon-color.svg",
    "kubernetes":    f"{CNCF}/kubernetes/icon/color/kubernetes-icon-color.svg",
    "argo":          f"{CNCF}/argo/icon/color/argo-icon-color.svg",
    "prometheus":    f"{CNCF}/prometheus/icon/color/prometheus-icon-color.svg",
    "opencost":      f"{CNCF}/opencost/icon/color/Opencost_Icon_Color.svg",
    "kyverno":       f"{CNCF}/kyverno/icon/color/kyverno-icon-color.svg",
    "helm":          f"{CNCF}/helm/icon/color/helm-icon-color.svg",
    "crossplane":    f"{CNCF}/crossplane/icon/color/crossplane-icon-color.svg",

    "si-github":        f"{SIMPLE}/github.svg",
    "si-githubactions": f"{SIMPLE}/githubactions.svg",
    "si-go":            f"{SIMPLE}/go.svg",
    "si-grafana":       f"{SIMPLE}/grafana.svg",
    "si-terraform":     f"{SIMPLE}/terraform.svg",
    "si-postgresql":    f"{SIMPLE}/postgresql.svg",
    "si-mlflow":        f"{SIMPLE}/mlflow.svg",
    "si-ollama":        f"{SIMPLE}/ollama.svg",
    "si-docker":        f"{SIMPLE}/docker.svg",

    "langfuse":  f"{GH}/langfuse/langfuse/main/web/public/icon.svg",
    "karpenter": f"{GH}/aws/karpenter-provider-aws/main/website/static/favicon.svg",
    "deepeval":  f"{GH}/confident-ai/deepeval/main/docs/app/icon.svg",
    # Grafana publishes no SVG for Loki; the PNG is embedded as a data URI.
    "loki":      f"{GH}/grafana/loki/main/docs/sources/logo.png",
}

# Official hexes, from simple-icons' own data file.
BRAND = {
    "si-grafana": "#F46800", "si-github": "#181717", "si-githubactions": "#2088FF",
    "si-terraform": "#844FBA", "si-postgresql": "#4169E1", "si-mlflow": "#0194E2",
    "si-ollama": "#000000", "si-go": "#00ADD8", "si-docker": "#2496ED",
}

# Near-black wordmarks. On the black cards they would not be visible at all, so
# the stylesheet inverts anything carrying `lg-dark`.
DARK_MARKS = {"si-github", "si-ollama"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "idp-diagram-build"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def inline_svg(raw: str, slug: str) -> str:
    """Normalise one SVG into an inline element sized by CSS."""
    s = re.sub(r"<\?xml.*?\?>|<!--.*?-->|<!DOCTYPE.*?>", "", raw, flags=re.S).strip()
    m = re.search(r"<svg\b[^>]*>", s)
    if not m:
        raise ValueError(f"{slug}: no <svg> root")
    vb = re.search(r'viewBox="([^"]+)"', m.group(0))
    vb = vb.group(1) if vb else "0 0 24 24"
    body = s[m.end(): s.rfind("</svg>")]
    body = re.sub(r"<title>.*?</title>", "", body, flags=re.S)

    # Namespace class names. Several SVGs define their fills through a <style>
    # block using generic names like `.cls-1`; inlined together those rules land
    # in one document, the last definition wins, and earlier logos silently lose
    # their fills. Helm and Kyverno both rendered blank before this.
    prefix = slug.replace("-", "")
    for cls in sorted(set(re.findall(r"cls-\d+", body)), key=len, reverse=True):
        body = body.replace(cls, f"{prefix}-{cls}")

    fill = f' fill="{BRAND[slug]}"' if slug in BRAND else ""
    cls = "lg" + (" lg-dark" if slug in DARK_MARKS else "")
    return (f'<svg class="{cls}" viewBox="{vb}" xmlns="http://www.w3.org/2000/svg"'
            f' aria-hidden="true"{fill}>{body}</svg>')


def main() -> int:
    if not TEMPLATE.exists():
        print(f"missing template: {TEMPLATE}", file=sys.stderr)
        return 1

    logos, failed = {}, []
    for slug, url in SOURCES.items():
        try:
            raw = fetch(url)
        except Exception as e:                                  # noqa: BLE001
            failed.append((slug, f"{type(e).__name__}: {e}"))
            continue
        if url.endswith(".png"):
            b64 = base64.b64encode(raw).decode()
            logos[slug] = f'<img class="lg" src="data:image/png;base64,{b64}" alt="" aria-hidden="true">'
        else:
            logos[slug] = inline_svg(raw.decode("utf-8"), slug)
        print(f"  ok   {slug}")

    for slug, why in failed:
        print(f"  FAIL {slug}: {why}", file=sys.stderr)

    html = TEMPLATE.read_text()
    unresolved = set()

    def swap(m):
        slug = m.group(1)
        if slug not in logos:
            unresolved.add(slug)
            return ""          # a missing mark degrades to a text-only card
        return logos[slug]

    html = re.sub(r"\{\{([a-z0-9-]+)\}\}", swap, html)

    BUILD.mkdir(exist_ok=True)
    out = BUILD / "platform-planes.built.html"
    out.write_text(html)

    print(f"\n  {len(logos)} marks inlined -> {out.relative_to(HERE.parent.parent)}")
    if unresolved:
        # Not fatal: the diagram is still correct, it just loses those marks.
        print(f"  unresolved (rendered as text): {', '.join(sorted(unresolved))}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
