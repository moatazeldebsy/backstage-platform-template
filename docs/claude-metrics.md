# Claude Metrics

**Claude Metrics** (`/claude-metrics`, in the sidebar's Menu) shows Claude Code adoption and Anthropic API usage and cost for your Claude Console organization: active users, sessions, lines of code, tool accept rates, commits and PRs, per-department adoption, per-model and org-wide cost, per-user activity and idle seats.

<!-- Upstream links use mixed case on purpose: scripts/placeholders.conf rewrites the lowercase
     owner name when the template is personalised, and these must keep pointing at the plugin's repo.
     GitHub owner names are case-insensitive. -->
It comes from the [Claude Metrics Viewer](https://github.com/MoatazElDebsy/claude-metrics-viewer) Backstage plugins, installed from the prebuilt packages in `backstage/app/vendor/`. That repo's [integration guide](https://github.com/MoatazElDebsy/claude-metrics-viewer/blob/main/docs/backstage-integration.md) covers the plugins in general; this page covers this platform.

## Who can see it

Managers only. The page and every `/api/claude-metrics/*` route check the `claude-metrics.dashboard.read` permission, and `IdpPermissionPolicy` (`backstage/app/packages/backend/src/modules/idpPermissionPolicy.ts`) grants it to:

- members of `CLAUDE_METRICS_GROUPS`, by default `group:default/engineering-managers`, synced from the GitHub org's `engineering-managers` team (ADR-0004);
- platform admins (`group:default/platform-team`).

Everyone else, guests included, gets "You don't have access to Claude Metrics" and a `403` from the API. To change who's allowed, edit `CLAUDE_METRICS_GROUPS` and rebuild Backstage.

## Mock data (default)

Out of the box the dashboard serves a seeded 1,200-person demo organization (`claudeMetrics.dataSource: mock` in `backstage/app-config.yaml`), so it works with no key and no outbound calls. The page header says **Data source: mock**.

## Real data: the Anthropic Admin API key

Real data needs an **Anthropic Admin API key** (`sk-ant-admin…`):

- Create it in the Claude Console under **Settings → Admin keys**. Only organization admins can.
- It is **not** the `ANTHROPIC_API_KEY` in `local/.env` (the AI stack's regular key). The Admin API rejects regular keys, and every tab then shows a 503.
- An Admin key can manage the whole organization, while the dashboard only reads. Use a dedicated key (for example `backstage-claude-metrics`) that you can revoke on its own.

The backend reads it from the `ANTHROPIC_ADMIN_KEY` environment variable (`claudeMetrics.adminKey: ${ANTHROPIC_ADMIN_KEY}` in `backstage/app-config.yaml`). It is never sent to the browser.

### Local (Docker Compose)

1. Add the key to `local/backstage/.env`:
   ```bash
   ANTHROPIC_ADMIN_KEY=sk-ant-admin-...
   ```
   `local/backstage/docker-compose.yml` passes it into the `backstage` container.
2. In `backstage/app-config.local.yaml`, uncomment:
   ```yaml
   claudeMetrics:
     dataSource: anthropic
   ```
3. Recreate the container so it picks up the new variable (config and env only, no image rebuild):
   ```bash
   docker compose -f local/backstage/docker-compose.yml up -d backstage
   ```
   If the ingress stops answering afterwards, run `./scripts/bootstrap-local.sh --update-backstage-ip`.

### AWS (EKS)

1. Put the key in the `idp-mvp/backstage` entry in AWS Secrets Manager, either by hand or by exporting it before bootstrap (`bootstrap.sh` copies `ANTHROPIC_ADMIN_KEY` into that entry when it's set):
   ```bash
   export ANTHROPIC_ADMIN_KEY=sk-ant-admin-...
   ./scripts/bootstrap.sh --profile medium
   ```
   The `backstage-secrets` ExternalSecret syncs it into the cluster (hourly), and `aws/backstage/deployment.yaml` maps it to the `ANTHROPIC_ADMIN_KEY` env var.
2. In `backstage/app-config.aws.yaml`, uncomment:
   ```yaml
   claudeMetrics:
     dataSource: anthropic
   ```
3. Roll out Backstage so it reads the new config and secret:
   ```bash
   kubectl rollout restart deploy/backstage -n backstage
   ```

With `dataSource: anthropic` and no key, the plugin fails at startup with `claudeMetrics.adminKey is required when dataSource is anthropic` in the backend log, and `/api/claude-metrics/*` returns `503`. The rest of Backstage keeps working. Both environments stay on mock data until you switch them.

### Check it

- The page header says **Data source: anthropic** and the numbers are your organization's.
- Check the key reached the container without printing it:
  ```bash
  docker exec backstage-backstage-1 sh -c 'test -n "$ANTHROPIC_ADMIN_KEY" && echo set || echo missing'          # local
  kubectl exec -n backstage deploy/backstage -- sh -c 'test -n "$ANTHROPIC_ADMIN_KEY" && echo set || echo missing'  # AWS
  ```

### Rotate it

Create a new Admin key, update `local/backstage/.env` or the Secrets Manager entry, recreate or restart Backstage (the key is read once per process), check the page loads, then revoke the old key in the Console.

## Departments (optional)

The Console has no team concept. To fill the Departments tab, point `claudeMetrics.departmentsFile` at an `email,department` CSV exported from your HR system or IdP. Without it, everyone shows as **Unassigned**. The file must be readable inside the container and is read once at startup.
