# ${{ values.name }} — Model Serving API

## Overview

This repository deploys a REST API for serving the **${{ values.modelName }}** model on **${{ values.target }}** infrastructure.

### Model Card

- **Model**: ${{ values.modelName }}
- **Type**: Open-source Language Model
- **Deployment Target**: ${{ values.target }}
- **Owner**: ${{ values.owner }}
- **Status**: Production

### Access

- **API Endpoint**: `http://${{ values.name }}.idp.local` (local) or `https://${{ values.name }}.prod.company.com` (AWS)
- **OpenAPI Docs**: `http://${{ values.name }}.idp.local/docs`
- **Health Check**: `http://${{ values.name }}.idp.local/health`
- **Metrics**: `http://${{ values.name }}.idp.local/metrics`

### Quick Start

#### Local (Ollama)

```bash
# The Kubernetes Deployment will automatically pull and serve the model
# Test the health endpoint:
curl http://${{ values.name }}.idp.local/health

# Make a prediction:
curl -X POST http://${{ values.name }}.idp.local/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is Kubernetes?", "max_tokens":100}'
```

#### AWS (vLLM)

```bash
# Ensure the EKS cluster has GPU nodes available
# The Deployment will schedule on nodes with label: accelerator=nvidia-tesla-t4
# Once running, access via the ALB:
curl https://${{ values.name }}.prod.company.com/health
```

### API Examples

#### Completion (Chat)

```bash
curl -X POST http://${{ values.name }}.idp.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "${{ values.modelName }}",
    "messages": [{"role":"user", "content":"Explain microservices"}],
    "max_tokens": 150
  }'
```

#### Embeddings (if supported)

```bash
curl -X POST http://${{ values.name }}.idp.local/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":"How does Kubernetes work?", "model":"${{ values.modelName }}"}'
```

### Monitoring

- **Prometheus Metrics**: `/metrics`
- **Grafana Dashboard**: Visit http://grafana.idp.local and look for "AI Platform" dashboard
- **Logs**: 
  - Local: `kubectl logs -n ml-platform deployment/${{ values.name }}-ollama`
  - AWS: `kubectl logs -n ml-platform deployment/${{ values.name }}-vllm`

### Model Updates

To update the model version:

1. Edit the environment variable in the Kubernetes Deployment:
   ```bash
   kubectl edit deployment/${{ values.name }}-ollama -n ml-platform
   ```
   Change `MODEL_NAME` env var and save.

2. The Pod will restart and pull the new model.

### Scaling

#### Local (Kind)

Resources are limited. For heavier workloads:
- Increase Deployment `resources.limits.memory` (default: 2Gi)
- Run on a workstation with more RAM

#### AWS (EKS)

- Auto-scaling via Karpenter (configured in the platform)
- HPA rules in the Deployment ensure more replicas on high load
- GPU nodes are reserved via node affinity

### Metrics to Track

- `http_requests_total` — Total API requests
- `http_request_duration_seconds` — Request latency (P50/P95/P99)
- `model_inference_tokens_total` — Total tokens generated
- `model_queue_depth` — Pending requests waiting for inference

### Troubleshooting

#### Model fails to load

```bash
kubectl logs deployment/${{ values.name }}-ollama -n ml-platform | grep -i error
```

**Solution**: Ensure the image tag matches the model name. Ollama uses `ollama/ollama` with the model pulled at startup.

#### Out of Memory

If the server crashes with OOM:

1. Local: Reduce `max_model_size` or use a smaller model
2. AWS: Ensure the GPU has enough VRAM (Tesla T4 has 16GB); use a quantized model if needed

#### API timeouts

Increase `max_concurrent_requests` in the deployment to allow more parallel inference.

### Related Links

- [Ollama Documentation](https://github.com/ollama/ollama)
- [vLLM Documentation](https://docs.vllm.ai/)
- [MLflow Integration](../../ml-platform/mlflow.yaml)
- [IDP Catalog](<{{ backbase }}/catalog>)
- [Monitoring & Metrics](<{{ backbase }}/grafana>)

### Support

For issues or feature requests:
1. Create an issue in this GitHub repo
2. Ping `#ai-platform` in Slack
3. Check the [Backstage IDP AI docs](<{{ backbase }}/docs/ai-platform>)
