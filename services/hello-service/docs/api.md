# API Reference

## GET /

Returns service metadata.

**Response**
```json
{
  "message": "Hello from the IDP!",
  "service": "hello-service",
  "version": "abc1234"
}
```

## GET /healthz

Kubernetes liveness probe. Returns `200 OK` when the service is alive.

## GET /ready

Kubernetes readiness probe. Returns `200 OK` when the service is ready to receive traffic.
