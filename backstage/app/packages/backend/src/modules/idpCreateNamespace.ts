import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

const kubeEnv = {
  ...process.env,
  KUBECONFIG: process.env.KUBECONFIG ?? '/tmp/kubeconfig',
};

const TIER_QUOTAS: Record<string, { cpu: string; cpuLimit: string; memory: string; memoryLimit: string; pods: string }> = {
  small: { cpu: '4', cpuLimit: '8', memory: '8Gi', memoryLimit: '16Gi', pods: '30' },
  medium: { cpu: '16', cpuLimit: '32', memory: '32Gi', memoryLimit: '64Gi', pods: '100' },
};

function buildNamespaceYaml(opts: {
  name: string;
  tier: string;
  networkPolicy: boolean;
}): string {
  const { name, tier, networkPolicy } = opts;

  const docs = [
    `apiVersion: v1
kind: Namespace
metadata:
  name: ${name}
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
    idp.io/tier: ${tier}
    managed-by: idp-backstage`,
  ];

  const quota = TIER_QUOTAS[tier];
  if (quota) {
    docs.push(`apiVersion: v1
kind: ResourceQuota
metadata:
  name: idp-quota
  namespace: ${name}
  labels:
    idp.io/tier: ${tier}
    managed-by: idp-backstage
spec:
  hard:
    requests.cpu: "${quota.cpu}"
    requests.memory: ${quota.memory}
    limits.cpu: "${quota.cpuLimit}"
    limits.memory: ${quota.memoryLimit}
    pods: "${quota.pods}"`);
  }

  if (networkPolicy) {
    docs.push(`apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: ${name}
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector: {}
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - protocol: TCP
          port: 8080
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system`);
  }

  return docs.join('\n---\n') + '\n';
}

function createCreateNamespaceAction() {
  return createTemplateAction({
    id: 'idp:create-namespace',
    description:
      'Create a Kubernetes namespace with Pod Security Standards, a tiered ' +
      'ResourceQuota, and a default-deny NetworkPolicy — applied immediately ' +
      'to the cluster (no PR/GitOps round-trip). For full team onboarding ' +
      '(RBAC, ArgoCD project, catalog entity) use the team-namespace template instead.',
    schema: {
      input: {
        // The regex is enforced here rather than only in the handler: zod
        // rejects a bad name before any cluster call is made.
        name: z =>
          z
            .string()
            .regex(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/)
            .describe('Lowercase, alphanumeric + hyphens (e.g. scratch-payments)'),
        tier: z =>
          z
            .enum(['small', 'medium', 'large'])
            .optional()
            .describe('small: 4 CPU / 8Gi. medium: 16 CPU / 32Gi. large: no quota (LimitRange defaults only). Default: small'),
        networkPolicy: z =>
          z.boolean().optional().describe('Apply default-deny NetworkPolicy (default: true)'),
      },
      output: {
        namespace: z => z.string().describe('Namespace created'),
      },
    },

    async handler(ctx) {
      const { name, tier = 'small', networkPolicy = true } = ctx.input;

      ctx.logger.info(`Creating namespace '${name}' (tier: ${tier}, networkPolicy: ${networkPolicy})...`);

      try {
        await execFileAsync('kubectl', ['cluster-info', '--request-timeout=5s'], { env: kubeEnv, timeout: 10_000 });
      } catch (e: any) {
        throw new Error(`Cannot reach the cluster: ${e.message}`);
      }

      const yaml = buildNamespaceYaml({ name, tier, networkPolicy });

      const tmpFile = path.join(os.tmpdir(), `namespace-${name}-${Date.now()}.yaml`);
      try {
        await fs.writeFile(tmpFile, yaml, 'utf8');
        const { stdout, stderr } = await execFileAsync('kubectl', ['apply', '-f', tmpFile], { env: kubeEnv, timeout: 30_000 });
        if (stdout) ctx.logger.info(stdout.trim());
        if (stderr) ctx.logger.warn(stderr.trim());
      } finally {
        await fs.unlink(tmpFile).catch(() => undefined);
      }

      ctx.logger.info(`✓ Namespace '${name}' is ready`);
      ctx.output('namespace', name);
    },
  });
}

export const idpCreateNamespaceModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-create-namespace',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
      },
      async init({ scaffolder }) {
        scaffolder.addActions(createCreateNamespaceAction());
      },
    });
  },
});
