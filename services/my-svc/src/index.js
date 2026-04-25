const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.json({ service: 'my-svc', status: 'ok' }));
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', (req, res) => res.json({ status: 'ready' }));

app.listen(port, () => console.log(JSON.stringify({ msg: 'listening', port })));
