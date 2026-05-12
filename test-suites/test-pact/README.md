# test-pact

Pact contract tests: **test-pact-consumer** → **hello-service**.

```bash
npm install
npm test                    # generate pacts/
PROVIDER_BASE_URL=http://localhost:8080 npm run verify
```

Set `PACT_BROKER_TOKEN` secret to publish to `https://YOUR_ORG.pactflow.io`.
