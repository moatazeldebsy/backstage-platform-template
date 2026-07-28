# JVM (Java/Kotlin) — dd-java-agent setup

1. Download the Datadog Java agent jar into your image/build:

   ```bash
   curl -Lo dd-java-agent.jar 'https://dtdg.co/latest-java-tracer'
   ```

2. Attach it via a `-javaagent` JVM flag (no code changes needed):

   ```
   JAVA_TOOL_OPTIONS="-javaagent:/app/dd-java-agent.jar"
   ```

   or in a Dockerfile:

   ```dockerfile
   ENTRYPOINT ["java", "-javaagent:/app/dd-java-agent.jar", "-jar", "/app/app.jar"]
   ```

3. Set the env vars from `datadog/README.md` (`DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `DD_SITE`,
   `DD_AGENT_HOST`, `DD_TRACE_AGENT_PORT`).
