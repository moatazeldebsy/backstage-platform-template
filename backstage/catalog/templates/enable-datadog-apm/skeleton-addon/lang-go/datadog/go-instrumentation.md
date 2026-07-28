# Go — dd-trace-go setup

1. Add the dependency:

   ```bash
   go get gopkg.in/DataDog/dd-trace-go.v1/ddtrace/tracer
   ```

2. Start the tracer at process startup, and wrap your HTTP router/middleware (example for
   `net/http`; see dd-trace-go's contrib packages for gin/echo/gRPC/etc.):

   ```go
   import (
     "gopkg.in/DataDog/dd-trace-go.v1/ddtrace/tracer"
     httptrace "gopkg.in/DataDog/dd-trace-go.v1/contrib/net/http"
   )

   func main() {
     tracer.Start()
     defer tracer.Stop()

     mux := httptrace.NewServeMux()
     // register routes on mux as usual
   }
   ```

3. Set the env vars from `datadog/README.md` (`DD_ENV`, `DD_SERVICE`, `DD_VERSION`, `DD_SITE`,
   `DD_AGENT_HOST`, `DD_TRACE_AGENT_PORT`).
