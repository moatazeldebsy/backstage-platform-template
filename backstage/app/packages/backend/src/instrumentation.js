/*
 * Prometheus metrics for the Backstage backend (#604).
 *
 * Preloaded with `node --require ./instrumentation.js packages/backend` (see
 * backstage/Dockerfile, local/backstage/docker-compose.yml and
 * aws/backstage/deployment.yaml), because HTTP instrumentation has to patch
 * the `http` module before the backend loads it.
 *
 * It registers a global OpenTelemetry MeterProvider whose reader is a
 * Prometheus exporter on :9464/metrics. That exposes:
 *   - Backstage's own metrics, which it already records through
 *     @opentelemetry/api (catalog processing, scaffolder tasks, scheduled
 *     tasks) and which went nowhere without a provider
 *   - http_server_* request metrics from the HTTP instrumentation, what a
 *     Backstage availability/latency SLO is built on
 * Metrics only, deliberately: no tracer provider, and none of the
 * auto-instrumentations bundle, so request handling pays for one histogram,
 * not a span per call.
 *
 * Set BACKSTAGE_METRICS_ENABLED=false to turn it off; the port can be changed
 * with BACKSTAGE_METRICS_PORT.
 */
const { metrics } = require('@opentelemetry/api');
const { MeterProvider } = require('@opentelemetry/sdk-metrics');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');

if (process.env.BACKSTAGE_METRICS_ENABLED !== 'false') {
  const port = Number(process.env.BACKSTAGE_METRICS_PORT ?? 9464);

  const exporter = new PrometheusExporter({ port }, err => {
    // A metrics endpoint that cannot bind must not take the portal down.
    if (err) console.warn(`[metrics] Prometheus exporter failed to start on :${port}: ${err.message}`);
  });

  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'backstage' }),
    readers: [exporter],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  registerInstrumentations({
    meterProvider,
    instrumentations: [
      new HttpInstrumentation({
        // Health probes would otherwise dominate the request counts an SLO is
        // computed from: the EKS probes (/ready, /healthz, in
        // aws/backstage/deployment.yaml), the Compose healthcheck (/healthcheck)
        // and Backstage's built-in health routes. The exporter serves scrapes on
        // its own port, so those never reach this hook.
        ignoreIncomingRequestHook: req => {
          const path = (req.url ?? '').split('?')[0];
          return (
            path === '/ready' ||
            path === '/healthz' ||
            path === '/healthcheck' ||
            path.startsWith('/.backstage/health')
          );
        },
      }),
    ],
  });
}
