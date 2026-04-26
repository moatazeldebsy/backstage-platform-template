const express = require('express');
const client = require('prom-client');

const app = express();
const PORT = process.env.PORT || 3000;

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'endpoint'],
  registers: [register],
});

app.get('/healthz', (req, res) => {
  httpRequests.labels('GET', '/healthz').inc();
  res.json({ status: 'ok' });
});

app.get('/ready', (req, res) => {
  httpRequests.labels('GET', '/ready').inc();
  res.json({ status: 'ready' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/', (req, res) => {
  httpRequests.labels('GET', '/').inc();
  res.json({ service: 'my-svc', status: 'running' });
});

app.listen(PORT, () => {
  console.log(JSON.stringify({ msg: 'my-svc listening', port: PORT }));
});

module.exports = app;
