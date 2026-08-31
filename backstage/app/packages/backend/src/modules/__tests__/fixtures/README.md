# Recorded responses

Real HTTP responses captured from the versions of each system this platform
deploys, not hand-written approximations.

They exist because hand-written fixtures cannot catch the failure they are most
often used to rule out: a collector calling the wrong endpoint, the wrong HTTP
method, or reading a field that does not exist. A fixture the author invented
agrees with whatever the author assumed, and the test passes against a shape the
real service will never send.

| File | Captured from | Endpoint |
|---|---|---|
| `mlflow-registered-models-search.json` | MLflow 2.13.0 | `GET /api/2.0/mlflow/registered-models/search?max_results=1000` |

To re-capture MLflow:

```bash
docker run -d --name mlflow-verify -p 5011:5000 ghcr.io/mlflow/mlflow:v2.13.0 \
  mlflow server --host 0.0.0.0 --port 5000 --backend-store-uri sqlite:////tmp/mlflow.db
curl -s 'http://localhost:5011/api/2.0/mlflow/registered-models/search?max_results=1000'
```

Note an empty registry answers `{}` — the `registered_models` key is absent
rather than an empty array.
