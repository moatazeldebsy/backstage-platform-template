import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { ensureKubeconfig, kubeEnv } from './kubeconfig';

const execAsync = promisify(exec);

const CONTRACT_MCP_HELM_VALUES = `
fullnameOverride: contract-mcp-server
replicaCount: 1
image:
  repository: localhost:5003/contract-mcp-server
  tag: "0.1.0"
  pullPolicy: Always
service:
  type: ClusterIP
  port: 3003
  targetPort: 3003
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
  hosts:
    - host: contract-mcp-server.idp.local
      paths:
        - path: /
          pathType: Prefix
  tls: []
livenessProbe:
  httpGet:
    path: /healthz
    port: http
  initialDelaySeconds: 10
  periodSeconds: 15
readinessProbe:
  httpGet:
    path: /ready
    port: http
  initialDelaySeconds: 5
  periodSeconds: 10
resources:
  requests:
    cpu: 50m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi
env:
  - name: BACKSTAGE_URL
    value: "http://host.docker.internal:3000"
  - name: BACKSTAGE_EXTERNAL_URL
    value: "http://backstage.idp.local"
  - name: BACKSTAGE_TOKEN
    value: "local-catalog-exporter-token"
  - name: PORT
    value: "3003"
  - name: NODE_TLS_REJECT_UNAUTHORIZED
    value: "0"
  - name: K8S_API
    value: "https://kubernetes.default.svc"
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: false
rbac:
  create: true
  rules:
    - apiGroups: [""]
      resources: ["services"]
      verbs: ["get", "list"]
backstage:
  kubernetesId: contract-mcp-server
podLabels:
  backstage.io/kubernetes-id: contract-mcp-server
`;

function buildContractToolserverYaml(): string {
  return `apiVersion: kagent.dev/v1alpha2
kind: RemoteMCPServer
metadata:
  name: contract-mcp-server
  namespace: kagent
spec:
  description: "Contract MCP server — register OpenAPI specs, generate Pact tests, detect breaking changes, validate compatibility"
  url: http://contract-mcp-server.services-dev.svc.cluster.local:3003/mcp
  protocol: STREAMABLE_HTTP
  timeout: 60s
`;
}

function buildContractAgentYaml(): string {
  return `apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: contract-assistant
  namespace: kagent
spec:
  type: Declarative
  description: "Contract Testing assistant — registers API specs, detects breaking changes, generates Pact consumer tests, validates compatibility."
  declarative:
    modelConfig: claude-anthropic
    systemMessage: |
      You are the Contract Testing Assistant for this Internal Developer Platform.
      You help engineers build self-describing, self-testing APIs by managing OpenAPI
      contracts and generating consumer-driven tests automatically.

      Tools available:
      - fetch_service_contract: Pull /openapi.json from a running service and auto-register it
      - auto_discover_contracts: Scan a namespace and register all services that expose a spec
      - register_contract: Manually push an OpenAPI spec (JSON or YAML)
      - get_contract: Retrieve a stored contract
      - list_contracts: List all registered services and versions
      - generate_contract_tests: Generate Pact JSON + TypeScript consumer tests
      - validate_compatibility: Check if provider satisfies all consumer-expected paths
      - detect_breaking_changes: Diff two spec versions for breaking changes
      - get_compatibility_report: Full compatibility matrix for a provider service
    tools:
      - type: McpServer
        mcpServer:
          kind: RemoteMCPServer
          name: contract-mcp-server
          namespace: kagent
          toolNames:
            - fetch_service_contract
            - auto_discover_contracts
            - register_contract
            - get_contract
            - list_contracts
            - generate_contract_tests
            - validate_compatibility
            - detect_breaking_changes
            - get_compatibility_report
      - type: McpServer
        mcpServer:
          kind: RemoteMCPServer
          name: idp-mcp-server
          namespace: kagent
          toolNames:
            - catalog_search
            - list_deployments
`;
}

async function callMcpTool(
  serverUrl: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${serverUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return null;
  const envelope = JSON.parse(dataLine.slice(6)) as {
    result?: { content?: Array<{ text?: string }> };
  };
  const rawText = envelope.result?.content?.[0]?.text;
  if (!rawText) return null;
  return JSON.parse(rawText) as Record<string, unknown>;
}

const EXEC_TIMEOUT_FAST_MS = 10_000;
const EXEC_TIMEOUT_DEPLOY_MS = 180_000;

async function isHelmReleaseDeployed(releaseName: string, namespace: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `helm status ${releaseName} --namespace ${namespace} --output json 2>/dev/null || echo "{}"`,
      { env: kubeEnv, timeout: EXEC_TIMEOUT_FAST_MS },
    );
    const status = JSON.parse(stdout.trim() || '{}') as { info?: { status?: string } };
    return status.info?.status === 'deployed';
  } catch {
    return false;
  }
}

function createSetupContractTestingAction() {
  return createTemplateAction({
    id: 'idp:setup-contract-testing',
    description:
      'Deploy the contract testing platform (contract-mcp-server + KAgent contract-assistant agent) ' +
      'and auto-register the target service contract. Idempotent — safe to run multiple times.',
    schema: {
      input: {
        targetService: z =>
          z.string().describe('Kubernetes service name to auto-register (must expose GET /openapi.json)'),
        targetNamespace: z =>
          z.string().optional().describe('Target service namespace (default: services-dev)'),
        targetPort: z =>
          z.number().optional().describe('K8s Service port, usually 80 (default: 80)'),
        skipDeploy: z =>
          z.boolean().optional().describe('Set true if contract-mcp-server is already running (default: false)'),
      },
      output: {
        contractServerUrl: z => z.string().describe('Contract MCP Server URL'),
        agentUrl: z => z.string().describe('KAgent UI URL'),
        contractRegistered: z => z.string().describe('Was a contract auto-discovered? (true/false)'),
        discoveredPaths: z => z.string().describe('Discovered API paths (JSON array)'),
      },
    },

    async handler(ctx) {
      const targetService = ctx.input['targetService'] as string;
      const targetNamespace = (ctx.input['targetNamespace'] as string | undefined) ?? 'services-dev';
      const targetPort = (ctx.input['targetPort'] as number | undefined) ?? 80;
      const skipDeploy = (ctx.input['skipDeploy'] as boolean | undefined) ?? false;

      // ── Step 1: Verify cluster is reachable ───────────────────────────────
      ctx.logger.info('Verifying Kubernetes cluster is reachable...');
      await ensureKubeconfig();
      try {
        await execAsync('kubectl cluster-info --request-timeout=5s', { env: kubeEnv, timeout: EXEC_TIMEOUT_FAST_MS });
      } catch (e: any) {
        throw new Error(`Cannot reach the Kubernetes cluster: ${e.message}`);
      }

      // ── Step 2: Deploy contract-mcp-server (idempotent) ───────────────────
      const contractServerUrl = process.env.CONTRACT_MCP_EXTERNAL_URL ?? 'http://contract-mcp-server.idp.local';
      const alreadyDeployed = await isHelmReleaseDeployed('contract-mcp-server', 'services-dev');

      if (skipDeploy || alreadyDeployed) {
        ctx.logger.info(
          alreadyDeployed
            ? 'contract-mcp-server already deployed — skipping Helm install'
            : 'skipDeploy=true — skipping Helm install',
        );
      } else {
        ctx.logger.info('Deploying contract-mcp-server via Helm...');
        const valuesFile = path.join(os.tmpdir(), `contract-mcp-values-${Date.now()}.yaml`);
        try {
          await fs.writeFile(valuesFile, CONTRACT_MCP_HELM_VALUES.trim(), 'utf8');
          const { stdout, stderr } = await execAsync(
            [
              'helm upgrade --install contract-mcp-server /helm/service-template',
              '--namespace services-dev --create-namespace',
              `--values ${valuesFile}`,
              '--wait --timeout 120s',
            ].join(' '),
            { env: kubeEnv, timeout: EXEC_TIMEOUT_DEPLOY_MS },
          );
          if (stdout) ctx.logger.info(stdout.trim());
          if (stderr) ctx.logger.warn(stderr.trim());
          ctx.logger.info('✓ contract-mcp-server deployed');
        } finally {
          await fs.unlink(valuesFile).catch(() => undefined);
        }
      }

      // ── Step 3: Apply KAgent RemoteMCPServer CRD (idempotent) ────────────
      ctx.logger.info('Applying KAgent RemoteMCPServer CRD...');
      const toolserverFile = path.join(os.tmpdir(), `contract-toolserver-${Date.now()}.yaml`);
      try {
        await fs.writeFile(toolserverFile, buildContractToolserverYaml(), 'utf8');
        const { stdout } = await execAsync(`kubectl apply -f ${toolserverFile}`, { env: kubeEnv, timeout: EXEC_TIMEOUT_FAST_MS });
        ctx.logger.info(stdout.trim());
      } finally {
        await fs.unlink(toolserverFile).catch(() => undefined);
      }

      // ── Step 4: Apply KAgent Agent CRD (idempotent) ───────────────────────
      ctx.logger.info('Applying KAgent contract-assistant Agent CRD...');
      const agentFile = path.join(os.tmpdir(), `contract-agent-${Date.now()}.yaml`);
      try {
        await fs.writeFile(agentFile, buildContractAgentYaml(), 'utf8');
        const { stdout } = await execAsync(`kubectl apply -f ${agentFile}`, { env: kubeEnv, timeout: EXEC_TIMEOUT_FAST_MS });
        ctx.logger.info(stdout.trim());
      } finally {
        await fs.unlink(agentFile).catch(() => undefined);
      }

      // ── Step 5: Wait for contract-mcp-server to be ready ─────────────────
      // Exponential backoff with jitter, capped at 5s, total deadline ~60s.
      // Avoids the fixed 5s × 12 cadence that kept polling at full rate even
      // when many setups ran in parallel.
      ctx.logger.info('Waiting for contract-mcp-server to be ready...');
      let ready = false;
      const readyDeadline = Date.now() + 60_000;
      let attempt = 0;
      while (Date.now() < readyDeadline) {
        try {
          const res = await fetch(`${contractServerUrl}/healthz`, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) { ready = true; break; }
        } catch { /* not ready yet */ }
        const base = Math.min(5000, 500 * Math.pow(2, attempt));
        const jitter = base * (0.8 + Math.random() * 0.4);
        await new Promise(r => setTimeout(r, jitter));
        attempt++;
      }
      if (!ready) {
        ctx.logger.warn('contract-mcp-server health check timed out — contract registration will be skipped');
      }

      // ── Step 6: Auto-register the target service contract ─────────────────
      let contractRegistered = false;
      let discoveredPaths: string[] = [];

      if (ready && targetService) {
        ctx.logger.info(`Fetching contract from ${targetService}...`);
        try {
          const result = await callMcpTool(contractServerUrl, 'fetch_service_contract', {
            service_name: targetService,
            namespace: targetNamespace,
            port: targetPort,
          });
          if (result?.discovered) {
            contractRegistered = true;
            discoveredPaths = (result.paths as string[] | undefined) ?? [];
            ctx.logger.info(
              `✓ Contract registered for ${targetService} v${result.version} — paths: ${discoveredPaths.join(', ')}`,
            );
          } else {
            ctx.logger.warn(
              `Could not auto-discover contract for ${targetService}. ` +
              `Ensure it exposes GET /openapi.json and re-run, or register manually.`,
            );
          }
        } catch (e: any) {
          ctx.logger.warn(`Contract fetch failed: ${e.message}`);
        }
      }

      const kagentUrl = process.env.KAGENT_EXTERNAL_URL ?? 'http://kagent.idp.local';
      ctx.logger.info(`✓ Contract testing platform is live`);
      ctx.logger.info(`  MCP Server: ${contractServerUrl}`);
      ctx.logger.info(`  Agent UI:   ${kagentUrl} (contract-assistant)`);

      ctx.output('contractServerUrl', contractServerUrl);
      ctx.output('agentUrl', kagentUrl);
      ctx.output('contractRegistered', String(contractRegistered));
      ctx.output('discoveredPaths', JSON.stringify(discoveredPaths));
    },
  });
}

export const idpSetupContractTestingModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-setup-contract-testing',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createSetupContractTestingAction());
      },
    });
  },
});
