# Scaffolded entities (local mode)

This directory is populated at runtime by the `idp:catalog-register-local`
scaffolder action when running in local-only mode (no real GITHUB_TOKEN).

Each subdirectory contains a `catalog-info.yaml` describing one scaffolded
service. The catalog backend ingests these via Location entities POSTed at
scaffold time and refreshed every catalog tick.

Files here are ephemeral local-dev artefacts — do NOT commit user-scaffolded
output. Keep this README and a `.gitkeep` so the directory exists on fresh clones.
