import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { provisionAwsSecret } from './idpProvisionSecret';
import { ensureKubeconfig, kubeEnv } from './kubeconfig';
import { writeSecureTempFile, cleanupSecureTempDir } from './secureTempFile';

const execFileAsync = promisify(execFile);

// Provisions a per-service LiteLLM virtual key + budget (ADR-0008), for the
// ai-agent-kagent template's optional "Provision LiteLLM virtual key" step.
//
// LiteLLM's own inbound-auth master key ($LITELLM_MASTER_KEY) must already be
// in this backend's environment — the same variable the /litellm proxy uses
// (see app-config.*.yaml), wired by bootstrap-ai.sh --litellm. This action
// calls LiteLLM directly rather than through that proxy: /key/generate is a
// privileged, write call, and the proxy is deliberately GET-only.
//
// Endpoint shapes confirmed against a live local instance (v1.100.1), not
// assumed — see docs/design/adr-0008-litellm-multiprovider-gateway.md.

interface LitellmKeyGenerateResponse {
  key?: string;
  token_id?: string;
  key_alias?: string;
  max_budget?: number;
}

interface LitellmKeyListResponse {
  keys?: string[];
}

function resolveLitellmBaseUrl(): string {
  // Same override-with-environment-appropriate-default shape as
  // idpDeployAgent.ts's KAGENT_EXTERNAL_URL / idpSetupContractTesting.ts's
  // CONTRACT_MCP_EXTERNAL_URL: an explicit env var, set as a static
  // in-cluster DNS string on AWS (aws/backstage/deployment.yaml) where the
  // Backstage backend itself runs inside EKS, falling back to the local
  // ingress hostname otherwise.
  //
  // process.env.K8S_CLUSTER_URL is NOT a valid signal here — it is set in
  // both environments (it only tells the Kubernetes plugin how to reach the
  // API server) and does not indicate whether this backend process is
  // itself network-reachable to in-cluster service DNS. Locally, Backstage
  // runs in Docker Compose outside Kind, so a cluster-internal hostname
  // fails with "TypeError: fetch failed" — confirmed live (ADR-0008 e2e run).
  return process.env.LITELLM_BASE_URL ?? 'http://litellm.idp.local';
}

async function litellmRequest<T>(
  baseUrl: string,
  masterKey: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const resp = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${masterKey}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = (await resp.json().catch(() => ({}))) as T;
  return { status: resp.status, body };
}

export function createProvisionLitellmKeyAction() {
  return createTemplateAction({
    id: 'idp:provision-litellm-key',
    description:
      'Mint a per-service LiteLLM virtual key with a spend budget (ADR-0008), and store it as a Kubernetes Secret / AWS Secrets Manager entry.',
    schema: {
      input: {
        serviceName: z => z.string().describe('Name of the owning service — becomes the LiteLLM key_alias (must be unique)'),
        budgetUsd: z => z.number().optional().describe('Monthly spend budget in USD (default: 50)'),
        durationDays: z => z.number().optional().describe('Key validity in days (default: 30)'),
        awsRegion: z => z.string().optional().describe('AWS region for Secrets Manager (default: us-east-1)'),
      },
      output: {
        virtualKeyAnnotationValue: z =>
          z.string().describe('Opaque LiteLLM key id (token_id) — never the raw key value — for the backstage.io/litellm-virtual-key-id annotation'),
        budgetUsd: z => z.number().describe('The budget actually set, for the idp.io/litellm-budget-usd annotation'),
        secretStorageLocation: z => z.string().describe('Where the raw key was stored, for operator visibility'),
      },
    },

    async handler(ctx) {
      const { serviceName, awsRegion = 'us-east-1' } = ctx.input;
      const budgetUsd = (ctx.input.budgetUsd as number | undefined) ?? 50;
      const durationDays = (ctx.input.durationDays as number | undefined) ?? 30;

      // Defense in depth: the ai-agent-kagent template's own JSON Schema
      // already constrains this (pattern: '^[a-z][a-z0-9-]{2,30}$'), but that
      // only holds for callers going through that one form. serviceName is
      // interpolated directly into a YAML manifest below and into an AWS
      // Secrets Manager path — an unvalidated value reaching this action any
      // other way (a different template, a future MCP tool) could inject
      // extra manifest fields/resources into the kubectl apply.
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(serviceName)) {
        throw new Error(
          `Invalid serviceName '${serviceName}': must match ^[a-z][a-z0-9-]{0,62}$ (DNS-1123 label rules).`,
        );
      }

      const masterKey = process.env.LITELLM_MASTER_KEY;
      if (!masterKey) {
        throw new Error(
          'LITELLM_MASTER_KEY is not set on the Backstage backend. It is written by ' +
            "scripts/bootstrap-ai.sh --litellm — see docs/design/adr-0008-litellm-multiprovider-gateway.md.",
        );
      }
      const baseUrl = resolveLitellmBaseUrl();
      const keyAlias = serviceName;

      ctx.logger.info(`Provisioning LiteLLM virtual key '${keyAlias}' (budget $${budgetUsd}/mo) at ${baseUrl}...`);

      const generated = await litellmRequest<LitellmKeyGenerateResponse>(baseUrl, masterKey, '/key/generate', {
        method: 'POST',
        body: JSON.stringify({ key_alias: keyAlias, max_budget: budgetUsd, duration: `${durationDays}d` }),
      });

      if (generated.status === 400) {
        // LiteLLM enforces unique key_alias and 400s rather than upserting —
        // confirmed live, not assumed (see ADR-0008). Treat "already exists"
        // as the idempotent case: look the existing key up by alias instead
        // of failing the scaffold run on a re-run/retry.
        ctx.logger.info(`Key alias '${keyAlias}' already exists — looking it up instead of minting a duplicate.`);
        const listed = await litellmRequest<LitellmKeyListResponse>(
          baseUrl,
          masterKey,
          `/key/list?key_alias=${encodeURIComponent(keyAlias)}`,
        );
        const existingTokenId = listed.body.keys?.[0];
        if (!existingTokenId) {
          throw new Error(
            `LiteLLM reported key_alias '${keyAlias}' already exists but /key/list returned none. ` +
              `Raw /key/generate response: ${JSON.stringify(generated.body)}`,
          );
        }
        // The raw key value is only ever returned by the original
        // /key/generate call — an already-existing key has no retrievable
        // secret. The scaffolder action can still refresh the catalog
        // annotation from the existing token_id; the Secret that already
        // exists for this service is left untouched rather than overwritten
        // with a value we cannot actually produce.
        ctx.output('virtualKeyAnnotationValue', existingTokenId);
        ctx.output('budgetUsd', budgetUsd);
        ctx.output('secretStorageLocation', '(pre-existing — not re-provisioned)');
        ctx.logger.info(`✓ Reused existing LiteLLM key '${keyAlias}' (id ${existingTokenId})`);
        return;
      }

      if (generated.status !== 200 || !generated.body.token_id || !generated.body.key) {
        throw new Error(
          `LiteLLM /key/generate failed (HTTP ${generated.status}): ${JSON.stringify(generated.body)}`,
        );
      }

      const tokenId = generated.body.token_id;
      const rawKey = generated.body.key;

      // NOT process.env.K8S_CLUSTER_URL — that only tells ensureKubeconfig()
      // whether to synthesize a kubeconfig from raw values instead of using
      // one already mounted; it is set locally too (local/.env), for exactly
      // that purpose, so branching on it here previously misrouted local runs
      // into the AWS Secrets Manager path ("Could not load credentials from
      // any providers" — confirmed live, ADR-0008 e2e run). NODE_ENV=production
      // is the real AWS-vs-local signal: set explicitly in
      // aws/backstage/deployment.yaml, left unset in local's docker-compose
      // (same fact the guest auth provider's dangerouslyAllowOutsideDevelopment
      // already relies on — see app-config.local.yaml).
      //
      // AWS: Secrets Manager, mirroring idpProvisionSecret.ts exactly (via the
      // shared provisionAwsSecret helper). Local (Kind, no Secrets Manager): a
      // plain Kubernetes Secret in services-dev, applied directly — a
      // genuinely new branch, not inherited from any existing action.
      let secretStorageLocation: string;
      if (process.env.NODE_ENV === 'production') {
        const secretPath = `idp-mvp/services/${serviceName}/LITELLM_VIRTUAL_KEY`;
        const { secretArn } = await provisionAwsSecret({
          secretPath,
          secretValue: rawKey,
          awsRegion,
          description: `LiteLLM virtual key for service: ${serviceName} (ADR-0008)`,
          tags: [
            { Key: 'managed-by', Value: 'idp-backstage' },
            { Key: 'service', Value: serviceName },
          ],
        });
        secretStorageLocation = secretArn;
        ctx.logger.info(`✓ LiteLLM key stored in Secrets Manager: ${secretArn}`);
      } else {
        await ensureKubeconfig();
        const secretName = `${serviceName}-litellm-key`;
        const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: services-dev
  labels:
    managed-by: idp-backstage
    service: ${serviceName}
type: Opaque
stringData:
  LITELLM_VIRTUAL_KEY: "${rawKey}"
`;
        const { dir, filePath: tmpFile } = await writeSecureTempFile('litellm-key', `${secretName}.yaml`, secretYaml);
        try {
          const { stdout, stderr } = await execFileAsync('kubectl', ['apply', '-f', tmpFile], { env: kubeEnv, timeout: 30_000 });
          if (stdout) ctx.logger.info(stdout.trim());
          if (stderr) ctx.logger.warn(stderr.trim());
        } finally {
          await cleanupSecureTempDir(dir);
        }
        secretStorageLocation = `local-secret:services-dev/${secretName}`;
        ctx.logger.info(`✓ LiteLLM key stored as Kubernetes Secret: ${secretStorageLocation}`);
      }

      ctx.output('virtualKeyAnnotationValue', tokenId);
      ctx.output('budgetUsd', budgetUsd);
      ctx.output('secretStorageLocation', secretStorageLocation);
    },
  });
}

export const idpProvisionLitellmKeyModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-provision-litellm-key',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createProvisionLitellmKeyAction());
      },
    });
  },
});
