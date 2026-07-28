# Python — ddtrace setup

1. Add the dependency:

   ```bash
   pip install ddtrace
   ```

2. Wrap your process start command with `ddtrace-run` (no code changes needed for common
   frameworks like Flask/Django/FastAPI):

   ```bash
   ddtrace-run python app.py
   # or, in a Dockerfile CMD:
   CMD ["ddtrace-run", "python", "app.py"]
   ```

3. Set the env vars from `datadog/README.md` (`DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `DD_SITE`,
   `DD_AGENT_HOST`, `DD_TRACE_AGENT_PORT`).
