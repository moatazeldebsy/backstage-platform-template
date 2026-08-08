import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

const KUBECONFIG_PATH = process.env.KUBECONFIG ?? '/tmp/kubeconfig';

const kubeEnv = {
  ...process.env,
  KUBECONFIG: KUBECONFIG_PATH,
};

async function ensureKubeconfig(): Promise<void> {
  const k8sUrl = process.env.K8S_CLUSTER_URL;
  const k8sToken = process.env.K8S_SERVICE_ACCOUNT_TOKEN;
  const k8sCa = process.env.K8S_CLUSTER_CA_B64;
  if (!k8sUrl || !k8sToken) return;
  if (!k8sCa) throw new Error('K8S_CLUSTER_CA_B64 env var required for secure TLS connections');

  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${k8sUrl}
    certificate-authority-data: ${k8sCa}
  name: cluster
contexts:
- context:
    cluster: cluster
    user: backstage
  name: default
current-context: default
users:
- name: backstage
  user:
    token: ${k8sToken}
`;
  await fs.writeFile(KUBECONFIG_PATH, kubeconfig, { encoding: 'utf8', mode: 0o600 });
}

function buildOllamaYaml(name: string, modelName: string): string {
  // Uses a lightweight Python Alpine mock (~50MB) instead of Ollama (~2.7GB).
  // Serves the same OpenAI-compatible API shape for demo/scaffold purposes.
  // Model name is passed via MODEL_NAME env var — never interpolated into Python source.
  const mockScript = `
import json, os, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("MODEL_NAME", "unknown")

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass
    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(data))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path in ("/health", "/readyz", "/healthz"):
            self.send_json(200, {"status": "ok", "model": MODEL})
        elif self.path == "/metrics":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            label = MODEL.replace('"', '')
            self.wfile.write(f'model_server_requests_total{{model="{label}"}} 0\\n'.encode())
        elif self.path == "/v1/models":
            self.send_json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        else:
            self.send_json(404, {"error": "not found"})
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        if self.path == "/v1/completions":
            self.send_json(200, {"id": str(uuid.uuid4()), "object": "text_completion",
                "model": MODEL, "choices": [{"text": f"[mock] Hello from {MODEL}!", "index": 0}]})
        elif self.path == "/v1/chat/completions":
            self.send_json(200, {"id": str(uuid.uuid4()), "object": "chat.completion",
                "model": MODEL, "choices": [{"message": {"role": "assistant",
                "content": f"[mock] Hello from {MODEL}! This is a scaffold demo."}, "index": 0}]})
        else:
            self.send_json(404, {"error": "not found"})

# Threading, not the plain HTTPServer: that one serialises requests, so a
# single slow call blocks the readiness and liveness probes behind it and the
# kubelet kills a container that is actually healthy.
ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`.trim();

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}-mock-server
  namespace: ml-platform
data:
  server.py: |
${mockScript.split('\n').map(l => '    ' + l).join('\n')}

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}-model-server
  namespace: ml-platform
  labels:
    backstage.io/kubernetes-id: ${name}
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/component: model-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${name}
        backstage.io/kubernetes-id: ${name}
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
      - name: model-server
        image: python:3.12-alpine
        imagePullPolicy: IfNotPresent
        command: ["python", "/app/server.py"]
        env:
        - name: MODEL_NAME
          value: "${modelName}"
        ports:
        - name: api
          containerPort: 8080
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: [ALL]
          readOnlyRootFilesystem: false
        # A cold python:3.12-alpine start on a contended local Kind node,
        # capped at 200m CPU, regularly needs more than the 10s that
        # livenessProbe alone allowed — the kubelet killed the container
        # mid-startup ("connection refused") and it restart-looped. The
        # startupProbe gives it up to 150s to listen, and liveness does not
        # begin evaluating until startup succeeds, so steady-state failure
        # detection is unchanged. Same pattern as MLflow in
        # kubernetes/ml-platform/mlflow.yaml.
        # timeoutSeconds defaults to 1 on every probe, which this server misses
        # under load ("context deadline exceeded") even while healthy — so it
        # is set explicitly on all three, startup included.
        startupProbe:
          httpGet:
            path: /health
            port: api
          periodSeconds: 5
          timeoutSeconds: 5
          failureThreshold: 30
        readinessProbe:
          httpGet:
            path: /health
            port: api
          periodSeconds: 5
          timeoutSeconds: 5
        livenessProbe:
          httpGet:
            path: /health
            port: api
          periodSeconds: 10
          timeoutSeconds: 5
        volumeMounts:
        - name: script
          mountPath: /app
      volumes:
      - name: script
        configMap:
          name: ${name}-mock-server

---
apiVersion: v1
kind: Service
metadata:
  name: ${name}-model-server
  namespace: ml-platform
  labels:
    app.kubernetes.io/name: ${name}
spec:
  type: ClusterIP
  ports:
  - name: api
    port: 8080
    targetPort: api
  selector:
    app.kubernetes.io/name: ${name}

---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ${name}
  namespace: ml-platform
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  endpoints:
    - port: api
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
  namespaceSelector:
    matchNames:
      - ml-platform

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}-model-server
  namespace: ml-platform
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
spec:
  ingressClassName: nginx
  rules:
  - host: ${name}.idp.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${name}-model-server
            port:
              number: 8080
`;
}

function buildVllmYaml(name: string, modelName: string): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}-vllm
  namespace: ml-platform
  labels:
    backstage.io/kubernetes-id: ${name}
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/component: model-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
      app.kubernetes.io/instance: vllm
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${name}
        app.kubernetes.io/instance: vllm
        backstage.io/kubernetes-id: ${name}
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: accelerator
                operator: In
                values:
                - nvidia-tesla-t4
                - nvidia-tesla-v100
                - nvidia-tesla-a100
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
      - name: vllm
        # Pinned, not :latest. vLLM ships breaking changes between minor
        # releases and publishes nightlies to the same repo, so :latest silently
        # re-rolls the serving stack under a scaffolded service — the same class
        # of failure as the unpinned MLflow client (see MLFLOW_CLIENT_VERSION in
        # idpRunTrainingJob.ts). Bump deliberately after checking the release
        # notes for API and GPU-driver changes.
        image: vllm/vllm-openai:v0.26.0
        imagePullPolicy: IfNotPresent
        env:
        - name: MODEL_NAME
          value: "${modelName}"
        - name: PORT
          value: "8000"
        - name: CUDA_VISIBLE_DEVICES
          value: "0"
        ports:
        - name: api
          containerPort: 8000
          protocol: TCP
        - name: metrics
          containerPort: 8001
          protocol: TCP
        resources:
          requests:
            cpu: 2000m
            memory: 8Gi
            nvidia.com/gpu: 1
          limits:
            cpu: 4000m
            memory: 16Gi
            nvidia.com/gpu: 1
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: false
        # vLLM has to pull the model weights and load them onto the GPU before
        # it serves anything, which for a cold cache is minutes, not seconds —
        # far past the ~90s that livenessProbe alone allowed (initialDelay 60 +
        # 3 x period 10), so the kubelet killed it mid-download and it could
        # never finish starting. The startupProbe allows 15 minutes; liveness
        # and readiness do not evaluate until it succeeds, which is also why
        # neither needs initialDelaySeconds any more.
        startupProbe:
          httpGet:
            path: /health
            port: api
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 90
        livenessProbe:
          httpGet:
            path: /health
            port: api
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        # /health, not /readiness: vLLM's OpenAI-compatible server does not
        # serve a /readiness path, so this probe 404'd forever and the pod
        # never went Ready — leaving the Service with no endpoints.
        readinessProbe:
          httpGet:
            path: /health
            port: api
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2

---
apiVersion: v1
kind: Service
metadata:
  name: ${name}-vllm
  namespace: ml-platform
  labels:
    app.kubernetes.io/name: ${name}
spec:
  type: ClusterIP
  ports:
  - name: api
    port: 8000
    targetPort: api
    protocol: TCP
  - name: metrics
    port: 8001
    targetPort: metrics
    protocol: TCP
  selector:
    app.kubernetes.io/name: ${name}
    app.kubernetes.io/instance: vllm

---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ${name}
  namespace: ml-platform
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ${name}
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
  namespaceSelector:
    matchNames:
      - ml-platform

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}-vllm
  namespace: ml-platform
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}-vllm
  minReplicas: 1
  maxReplicas: 3
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
`;
}

function createDeployModelServerAction() {
  return createTemplateAction({
    id: 'idp:deploy-model-server',
    description: 'Deploy an ML model as a REST API (Ollama for local Kind, vLLM for AWS EKS) to the ml-platform namespace.',
    schema: {
      input: {
        required: ['name', 'modelName', 'target'],
        type: 'object',
        properties: {
          name: { type: 'string', title: 'Model server name (k8s-safe)' },
          modelName: { type: 'string', title: 'Model name (e.g., llama3.2, mistral)' },
          target: {
            type: 'string',
            title: 'Deployment target (local or aws)',
            enum: ['local', 'aws'],
          },
        },
      },
      output: {
        type: 'object',
        properties: {
          serverUrl: { type: 'string', title: 'Model Server URL' },
          namespace: { type: 'string', title: 'Kubernetes namespace' },
          deploymentName: { type: 'string', title: 'Deployment name' },
        },
      },
    },

    async handler(ctx) {
      const name = ctx.input['name'] as string;
      const modelName = ctx.input['modelName'] as string;
      const target = ctx.input['target'] as string;

      // Strict input validation to prevent injection attacks
      const k8sNameRegex = /^[a-z][a-z0-9-]{2,30}$/;
      const modelNameRegex = /^[a-z0-9-]+$/;
      const targetRegex = /^(local|aws)$/;

      if (!k8sNameRegex.test(name)) {
        throw new Error(`Invalid name: must match pattern ${k8sNameRegex}. Got: ${name}`);
      }
      if (!modelNameRegex.test(modelName)) {
        throw new Error(`Invalid modelName: must match pattern ${modelNameRegex}. Got: ${modelName}`);
      }
      if (!targetRegex.test(target)) {
        throw new Error(`Invalid target: must be 'local' or 'aws'. Got: ${target}`);
      }

      ctx.logger.info(`Deploying model server '${name}' (model: ${modelName}, target: ${target})...`);

      // Verify cluster is reachable
      try {
        if (target === 'aws') {
          await ensureKubeconfig();
        }
        await execFileAsync('kubectl', ['cluster-info', '--request-timeout=5s'], { env: kubeEnv, timeout: 10_000 });
      } catch (e: any) {
        throw new Error(`Cannot reach the cluster: ${e.message}`);
      }

      // Build the appropriate YAML based on target
      const yaml = target === 'local'
        ? buildOllamaYaml(name, modelName)
        : buildVllmYaml(name, modelName);

      const tmpFile = path.join(os.tmpdir(), `model-server-${name}-${Date.now()}.yaml`);
      try {
        await fs.writeFile(tmpFile, yaml, 'utf8');
        const { stdout, stderr } = await execFileAsync('kubectl', ['apply', '-f', tmpFile], { env: kubeEnv, timeout: 30_000 });
        if (stdout) ctx.logger.info(stdout.trim());
        if (stderr) ctx.logger.warn(stderr.trim());
      } finally {
        await fs.unlink(tmpFile).catch(() => undefined);
      }

      // Wait for deployment to be ready
      ctx.logger.info(`Waiting for ${target === 'local' ? 'Ollama' : 'vLLM'} deployment to be ready...`);
      const deploymentName = target === 'local' ? `${name}-model-server` : `${name}-vllm`;
      try {
        await execFileAsync('kubectl', ['rollout', 'status', `deployment/${deploymentName}`, '-n', 'ml-platform', '--timeout=120s'],
          { env: kubeEnv, timeout: 130_000 },
        );
      } catch (e: any) {
        ctx.logger.warn(`Deployment may still be rolling out: ${e.message}`);
      }

      // Register the model in MLflow Model Registry so it appears in the MLflow UI
      const mlflowUrl = process.env.MLFLOW_EXTERNAL_URL ?? 'http://mlflow.idp.local';
      try {
        const createRes = await fetch(`${mlflowUrl}/api/2.0/mlflow/registered-models/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            tags: [
              { key: 'model_name', value: modelName },
              { key: 'deployment_target', value: target },
              { key: 'served_by', value: target === 'local' ? 'ollama-mock' : 'vllm' },
            ],
            description: `Model server for ${modelName} deployed via IDP (${target})`,
          }),
        });
        if (createRes.ok || createRes.status === 409) {
          // 409 = already exists, that's fine
          ctx.logger.info(`✓ Model '${name}' registered in MLflow Model Registry`);
        } else {
          const body = await createRes.text();
          ctx.logger.warn(`MLflow registration returned ${createRes.status}: ${body}`);
        }
      } catch (e: any) {
        ctx.logger.warn(`Could not register model in MLflow (non-fatal): ${e.message}`);
      }

      const serverUrl = target === 'local'
        ? `http://${name}.idp.local`
        : `https://${name}.prod.company.com`;

      ctx.logger.info(`✓ Model server '${name}' is deployed — ${serverUrl}`);
      ctx.output('serverUrl', serverUrl);
      ctx.output('namespace', 'ml-platform');
      ctx.output('deploymentName', deploymentName);
    },
  });
}

export const idpDeployModelServerModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-deploy-model-server',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createDeployModelServerAction());
      },
    });
  },
});
