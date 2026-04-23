# ${{ values.name }}

${{ values.description }}

## Health endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe — returns `{"status":"ok"}` |
| `GET /ready` | Readiness probe — returns `{"status":"ready"}` |

## Local development

```bash
npm install
npm run dev    # Vite dev server at http://localhost:5173
```

## Build

```bash
npm run build  # outputs to dist/
```

## Deployment

Deployed automatically via GitHub Actions on push to `main`.
Image is built, pushed to ECR, and deployed to EKS via Helm.
