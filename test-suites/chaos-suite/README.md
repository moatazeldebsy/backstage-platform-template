# chaos-suite

Chaos Mesh experiments for `hello-service` in namespace `services`. Duration: **2m**.

```bash
kubectl apply -f experiments/pod-failure.yaml
# wait 2m, then:
kubectl delete -f experiments/pod-failure.yaml
```
