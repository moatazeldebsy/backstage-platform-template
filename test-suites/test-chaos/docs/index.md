# test-chaos

Chaos Mesh resilience experiments for **hello-service** in `services`.
Duration per experiment: **1m**.

| Experiment | Type |
|-----------|------|
| pod-failure | PodChaos |
| network-latency | NetworkChaos |
| cpu-stress | StressChaos |
| memory-stress | StressChaos |
