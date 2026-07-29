import { collectDefaultMetrics } from 'prom-client';
import { bootstrap } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3009', 10);

collectDefaultMetrics();

bootstrap()
  .then(app => {
    app.listen(PORT, () => {
      console.log(`Approval Service listening on :${PORT}`);
    });
  })
  .catch(err => {
    console.error('[approval-service] failed to start:', err);
    process.exit(1);
  });
