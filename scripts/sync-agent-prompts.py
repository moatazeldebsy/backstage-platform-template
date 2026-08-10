#!/usr/bin/env python3
"""Keep KAgent agent prompts in sync across the places that copy them.

The `systemMessage` in kubernetes/kagent/*.yaml is the source of truth for what
an agent actually does in production. Two other places hold copies of it, and
both silently rot:

  1. test-suites/test-deepeval/tests/conftest.py — SYSTEM_PROMPT, which the
     DeepEval suite grades against. When it drifts, CI is scoring a prompt that
     is not deployed, and passing evals say nothing about the real agent.
  2. Langfuse prompt management, when Langfuse is deployed — used as the
     authoring/versioning surface so prompt changes have a history and a diff.

Modes
-----
  --check-evals   Fail if conftest.py's SYSTEM_PROMPT has drifted from
                  idp-agent.yaml. Cheap, needs no cluster and no Langfuse —
                  this is the one that belongs in CI.
  --sync-evals    Rewrite conftest.py's SYSTEM_PROMPT from the CRD.
  --push          Upload every agent's systemMessage to Langfuse as a versioned
                  prompt labelled "production". Idempotent; Langfuse creates a
                  new version only when the text actually changed.
  --check         Fail if any CRD's systemMessage differs from the
                  production-labelled prompt in Langfuse.

Note on scope: KAgent has no per-invocation prompt fetch, so Langfuse is a
versioning and review surface here, not a runtime source. `spec.declarative.
systemMessageFrom` (a ConfigMap/Secret reference) does exist in
kagent.dev/v1alpha2 and is the path to making Langfuse-authored prompts
deployable without editing CRDs — see docs/ai-assistant.md.

Deliberately does NOT write CRDs back from Langfuse: that would need
ruamel.yaml to preserve the literal block scalars and comments those files
depend on, and it inverts the GitOps direction. Add it only with a PR flow.
"""

from __future__ import annotations

import argparse
import difflib
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
KAGENT_DIR = REPO_ROOT / "kubernetes" / "kagent"
CONFTEST = REPO_ROOT / "test-suites" / "test-deepeval" / "tests" / "conftest.py"

# The eval suite grades this one agent.
EVAL_AGENT = KAGENT_DIR / "idp-agent.yaml"

# SYSTEM_PROMPT = """...""" — non-greedy so it stops at the first closing quotes.
SYSTEM_PROMPT_RE = re.compile(r'(SYSTEM_PROMPT = """)(.*?)(""")', re.DOTALL)


def _fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def load_yaml(path: Path):
    try:
        import yaml
    except ImportError:
        _fail("PyYAML is required: pip install pyyaml")
    with path.open() as fh:
        return yaml.safe_load(fh)


def agent_prompt(path: Path) -> str | None:
    """Return an Agent CRD's systemMessage, or None if it has none."""
    doc = load_yaml(path)
    if not isinstance(doc, dict) or doc.get("kind") != "Agent":
        return None
    decl = (doc.get("spec") or {}).get("declarative") or {}
    msg = decl.get("systemMessage")
    # systemMessageFrom points at a ConfigMap/Secret; there is no inline text to
    # sync, and reading the referenced object would need cluster access.
    return msg.strip() if isinstance(msg, str) else None


def all_agents() -> list[tuple[str, str]]:
    """(agent name, systemMessage) for every Agent CRD that has an inline one."""
    out = []
    for path in sorted(KAGENT_DIR.glob("*.yaml")):
        doc = load_yaml(path)
        if not isinstance(doc, dict) or doc.get("kind") != "Agent":
            continue
        prompt = agent_prompt(path)
        if prompt:
            out.append((doc["metadata"]["name"], prompt))
    return out


def conftest_prompt() -> str:
    src = CONFTEST.read_text()
    m = SYSTEM_PROMPT_RE.search(src)
    if not m:
        _fail(f"could not find SYSTEM_PROMPT = \"\"\"...\"\"\" in {CONFTEST}")
    return m.group(2).strip()


def check_evals() -> int:
    crd = agent_prompt(EVAL_AGENT)
    if crd is None:
        _fail(f"{EVAL_AGENT} has no inline spec.declarative.systemMessage")
    have = conftest_prompt()
    if have == crd:
        print("OK: conftest.py SYSTEM_PROMPT matches idp-agent.yaml.")
        return 0

    diff = "\n".join(
        difflib.unified_diff(
            have.splitlines(),
            crd.splitlines(),
            fromfile="conftest.py (SYSTEM_PROMPT)",
            tofile="kubernetes/kagent/idp-agent.yaml (systemMessage)",
            lineterm="",
        )
    )
    print(
        "DRIFT: the DeepEval suite is grading a prompt that is not deployed.\n"
        "The agent's real systemMessage has changed; conftest.py still has the old copy.\n"
        "Fix with: python3 scripts/sync-agent-prompts.py --sync-evals\n",
        file=sys.stderr,
    )
    print(diff, file=sys.stderr)
    return 1


def sync_evals() -> int:
    crd = agent_prompt(EVAL_AGENT)
    if crd is None:
        _fail(f"{EVAL_AGENT} has no inline spec.declarative.systemMessage")
    if '"""' in crd:
        _fail('systemMessage contains \'"""\' and cannot be embedded verbatim')
    if crd.endswith('"'):
        _fail('systemMessage ends with a quote, which would escape the closing delimiter')

    src = CONFTEST.read_text()
    new = SYSTEM_PROMPT_RE.sub(lambda m: m.group(1) + crd + m.group(3), src, count=1)
    if new == src:
        print("Already in sync — nothing to write.")
        return 0
    CONFTEST.write_text(new)
    print(f"Updated {CONFTEST.relative_to(REPO_ROOT)} from {EVAL_AGENT.name}.")
    print("Review the tool stubs too — a prompt referencing tools that TOOL_DEFINITIONS")
    print("does not define will change how the model behaves under eval.")
    return 0


def langfuse_client():
    host = os.environ.get("LANGFUSE_HOST")
    pk = os.environ.get("LANGFUSE_PUBLIC_KEY")
    sk = os.environ.get("LANGFUSE_SECRET_KEY")
    if not (host and pk and sk):
        print(
            "Langfuse is not configured (LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / "
            "LANGFUSE_SECRET_KEY) — skipping.",
        )
        return None
    try:
        from langfuse import Langfuse
    except ImportError:
        _fail("the langfuse SDK is required for --push/--check: pip install langfuse")
    return Langfuse(public_key=pk, secret_key=sk, host=host)


def push() -> int:
    client = langfuse_client()
    if client is None:
        return 0
    for name, prompt in all_agents():
        client.create_prompt(
            name=f"kagent/{name}",
            prompt=prompt,
            labels=["production"],
            type="text",
        )
        print(f"pushed kagent/{name} ({len(prompt.splitlines())} lines)")
    client.flush()
    return 0


def check() -> int:
    client = langfuse_client()
    if client is None:
        return 0
    drifted = []
    for name, prompt in all_agents():
        try:
            remote = client.get_prompt(f"kagent/{name}", label="production")
        except Exception as exc:  # not yet pushed, or Langfuse unreachable
            print(f"warn: kagent/{name} not in Langfuse ({exc})", file=sys.stderr)
            continue
        if remote.prompt.strip() != prompt:
            drifted.append(name)
    if drifted:
        print(
            "DRIFT vs Langfuse production prompts: " + ", ".join(drifted) + "\n"
            "Reconcile with: python3 scripts/sync-agent-prompts.py --push",
            file=sys.stderr,
        )
        return 1
    print("OK: all agent prompts match their Langfuse production versions.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check-evals", action="store_true", help="fail if conftest.py drifted from the CRD")
    g.add_argument("--sync-evals", action="store_true", help="rewrite conftest.py from the CRD")
    g.add_argument("--push", action="store_true", help="push CRD prompts to Langfuse")
    g.add_argument("--check", action="store_true", help="fail if CRDs differ from Langfuse")
    args = ap.parse_args()

    if args.check_evals:
        return check_evals()
    if args.sync_evals:
        return sync_evals()
    if args.push:
        return push()
    return check()


if __name__ == "__main__":
    sys.exit(main())
