# Node.js — dd-trace setup

1. Add the dependency:

   ```bash
   npm install dd-trace
   ```

2. Initialize tracing before any other import, either via an env var (recommended — matches
   how the Backstage backend itself is instrumented):

   ```
   NODE_OPTIONS=--require dd-trace/init
   ```

   or as the very first line of your entrypoint:

   ```javascript
   require('dd-trace').init();
   ```

3. Set the env vars from `datadog/README.md` (`DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `DD_SITE`,
   `DD_AGENT_HOST`, `DD_TRACE_AGENT_PORT`).
