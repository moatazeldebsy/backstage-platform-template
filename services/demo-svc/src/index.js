'use strict';

const express = require('express');

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

app.get('/', (_req, res) => res.json({ service: 'demo-svc', status: 'ok' }));
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));

app.listen(port, () => {
  process.stdout.write(JSON.stringify({ msg: 'listening', port }) + '\n');
});

module.exports = app;
