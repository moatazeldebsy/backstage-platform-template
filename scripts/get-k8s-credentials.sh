#!/usr/bin/env bash
# Creates a Backstage service account in the cluster and writes credentials
# to local/backstage/.env so the Kubernetes plugin can connect.
# Usage: ./scripts/get-k8s-credentials.sh

set -euo pipefail

ENV_FILE="$(dirname "$0")/../local/backstage/.env"

# ── Create RBAC for Backstage ────────────────────────────────────────────────
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backstage
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backstage-read
rules:
  - apiGroups: [""]
    resources: [pods, services, configmaps, resourcequotas, limitranges, namespaces, nodes]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments, replicasets, statefulsets, daemonsets]
    verbs: [get, list, watch]
  - apiGroups: [autoscaling]
    resources: [horizontalpodautoscalers]
    verbs: [get, list, watch]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses]
    verbs: [get, list, watch]
  - apiGroups: [metrics.k8s.io]
    resources: [pods, nodes]
    verbs: [get, list]
  - apiGroups: [batch]
    resources: [jobs, cronjobs]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backstage-read
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: backstage-read
subjects:
  - kind: ServiceAccount
    name: backstage
    namespace: default
---
apiVersion: v1
kind: Secret
metadata:
  name: backstage-token
  namespace: default
  annotations:
    kubernetes.io/service-account.name: backstage
type: kubernetes.io/service-account-token
EOF

echo "Waiting for token to populate..."
sleep 3

# ── Extract credentials ──────────────────────────────────────────────────────
CLUSTER_URL=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
# Backstage runs inside Docker — replace 127.0.0.1 with host.docker.internal
# so the Kubernetes plugin can reach the Kind API server from the container.
CLUSTER_URL_DOCKER="${CLUSTER_URL/127.0.0.1/host.docker.internal}"
SA_TOKEN=$(kubectl get secret backstage-token -n default -o jsonpath='{.data.token}' | base64 --decode)
CA_DATA=$(kubectl get secret backstage-token -n default -o jsonpath='{.data.ca\.crt}')

# ── Write to .env ────────────────────────────────────────────────────────────
# Preserve existing values, only update K8s lines
tmp=$(mktemp)
grep -v '^K8S_' "$ENV_FILE" > "$tmp" || true
cat >> "$tmp" <<EOF
K8S_CLUSTER_URL=${CLUSTER_URL_DOCKER}
K8S_SERVICE_ACCOUNT_TOKEN=${SA_TOKEN}
K8S_CLUSTER_CA_DATA=${CA_DATA}
EOF
mv "$tmp" "$ENV_FILE"

echo "Done. Credentials written to $ENV_FILE"
echo "  URL (host):   $CLUSTER_URL"
echo "  URL (docker): $CLUSTER_URL_DOCKER"
echo "  Token: ${SA_TOKEN:0:20}..."
