# Diagrams

Source for the generated diagrams in `docs/assets/`. They are built rather than
drawn so they can be updated when the platform changes, instead of quietly going
stale the way a hand-drawn export does.

## Platform planes

`docs/assets/platform-planes.png` — the five-plane systems view in the README.

```bash
# 1. fetch the logos and inline them
python3 docs/diagrams/build-platform-planes.py

# 2. render (playwright is already installed under backstage/app)
cd backstage/app
node ../../docs/diagrams/render.mjs \
  ../../docs/diagrams/.build/platform-planes.built.html \
  ../../docs/assets/platform-planes.png
```

The build is deterministic: run from a clean tree it reproduces the committed PNG
byte for byte.

| File | What it is |
|---|---|
| `platform-planes.html` | The diagram. Content, layout and the connector-drawing script. Logos appear as `{{slug}}` placeholders |
| `build-platform-planes.py` | Fetches each logo from upstream and inlines it. Standard library only |
| `render.mjs` | Screenshots the built page at 2x |
| `.build/` | Generated, git-ignored |

To change what the diagram says, edit `platform-planes.html` and re-run both steps.

## Why the logos are not committed

The marks belong to their projects. They are used here nominatively — to identify
the component each one names — which is the same use the
[CNCF reference architecture template](https://github.com/cncf/architecture)
demonstrates. Fetching them at build time keeps that boundary explicit, avoids
vendoring trademarks into an MIT-licensed repository, and picks up any rebrand.

Sources:

- **CNCF project marks** — [`cncf/artwork`](https://github.com/cncf/artwork)
  (Backstage, Kubernetes, Argo, Prometheus, OpenCost, Kyverno, Helm, Crossplane)
- **[simple-icons](https://github.com/simple-icons/simple-icons)** — icon files are
  CC0; each is tinted to the brand's own published hex
- **Project repositories** — Langfuse, Karpenter, DeepEval, Loki

A logo that cannot be fetched is not fatal. The build reports it and that card
renders as text, so a moved URL degrades the diagram rather than breaking it.

## Two traps worth knowing

**Colliding class names.** Several SVGs set their fills through a `<style>` block
using generic names like `.cls-1`. Inlined into one page those rules collide, the
last definition wins, and earlier logos lose their fills — Helm and Kyverno both
rendered blank before the build started namespacing them per logo.

**Near-black marks.** GitHub (`#181717`) and Ollama (`#000000`) disappear on the
dark cards. They carry `lg-dark` and the stylesheet inverts them.

The renderer checks for both: any mark with zero width after layout is reported
as blank rather than silently shipped.
