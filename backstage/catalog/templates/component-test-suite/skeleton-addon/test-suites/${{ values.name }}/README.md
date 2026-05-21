# Component Test Suite — ${{ values.name }}

Tests the service as a black box, with external HTTP dependencies stubbed by [WireMock](https://wiremock.org/).

**Pyramid layer:** component (between unit and integration). Faster than Testcontainers because no real DB/Kafka is started; more realistic than unit tests because the real service container is hit over HTTP.

## Layout

```
test-suites/${{ values.name }}/
├── tests/                      # Vitest specs
├── wiremock/mappings/          # WireMock stub mappings (JSON)
└── package.json
```

## Running locally

```bash
# 1. Start WireMock
docker run --rm -p 8089:8080 -v $PWD/wiremock:/home/wiremock wiremock/wiremock:3.9.1

# 2. Run the service-under-test with DOWNSTREAM_BASE_URL pointing at WireMock
DOWNSTREAM_BASE_URL=http://localhost:8089 <run your service>

# 3. Run the tests
SERVICE_URL=http://localhost:${{ values.servicePort }} WIREMOCK_URL=http://localhost:8089 \
  npm test
```

## Adding stubs

Drop JSON files into `wiremock/mappings/`. WireMock picks them up on container start. See the [WireMock stub mapping docs](https://wiremock.org/docs/stubbing/).
