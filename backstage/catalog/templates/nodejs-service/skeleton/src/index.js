const express = require('express');
const client = require('prom-client');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const app = express();
const PORT = process.env.PORT || ${{ values.port }};

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'endpoint', 'status_code'],
  registers: [register],
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'endpoint'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

function instrument(method, endpoint, handler) {
  return (req, res) => {
    const end = httpDuration.startTimer({ method, endpoint });
    handler(req, res);
    httpRequests.labels(method, endpoint, String(res.statusCode)).inc();
    end();
  };
}

app.get('/healthz', instrument('GET', '/healthz', (req, res) => {
  res.json({ status: 'ok' });
}));

app.get('/ready', instrument('GET', '/ready', (req, res) => {
  res.json({ status: 'ready' });
}));

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/openapi.json', (req, res) => {
  const specPath = path.join(__dirname, '..', 'openapi.yaml');
  const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
  res.json(spec);
});

app.get('/', instrument('GET', '/', (req, res) => {
  console.log(JSON.stringify({ msg: 'root called' }));
  res.json({ service: '${{ values.name }}', status: 'running' });
}));

app.listen(PORT, () => {
  console.log(JSON.stringify({ msg: `${{ values.name }} listening on port ${PORT}` }));
});

module.exports = app;
