# test-chaos

Chaos Mesh experiments for `hello-service` in namespace `services`. Duration: **1m**.

```bash
kubectl apply -f experiments/pod-failure.yaml
# wait 1m, then:
kubectl delete -f experiments/pod-failure.yaml
```
