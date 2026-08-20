import { collectDefaultMetrics } from 'prom-client';
import { createApp, initSchemaWithRetry } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3009', 10);

collectDefaultMetrics();

// Listen first, initialise the database second.
//
// This used to be `bootstrap()` — await initSchema(), then listen, and
// process.exit(1) on failure. Postgres comes from
// local/backstage/docker-compose.yml, so on a plain `bootstrap-local.sh` run
// (without --start-backstage) it does not exist, and this container went into
// CrashLoopBackOff on a cluster that was otherwise fine. ArgoCD then held the
// application Degraded indefinitely, and the restart churn added avoidable load
// to an already-tight local cluster.
//
// Now the process starts, serves /healthz, reports /ready as 503 until the
// schema exists, and keeps retrying — so it recovers on its own once the
// compose stack is brought up, with no restart required.
const app = createApp();

app.listen(PORT, () => {
  console.log(`Approval Service listening on :${PORT}`);
});

void initSchemaWithRetry().then(ok => {
  if (!ok) {
    console.error('[approval-service] gave up initialising the database schema');
  }
});
