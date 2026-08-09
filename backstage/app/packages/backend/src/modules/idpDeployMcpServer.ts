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

// imageTag defaults to 'latest' on purpose, unlike the third-party images
// elsewhere in this repo, which are pinned. The image this refers to is built
// by the scaffolded repo's own CI and does not exist yet at scaffold time, so
// there is no immutable tag to pin to here. The repo's CI then takes over: it
// pushes both :<sha8> and :latest, and rewrites kubernetes/mcpserver.yaml to
// the sha, so the GitOps manifest converges on a pinned tag. This CRD is the
// bootstrap that runs before that first build completes.
//
// Callers that already know a tag (a rebuild of a service whose image exists)
// can pass one to get an immutable deployment.
function buildMcpServerYaml(opts: {
  name: string;
  port: number;
  imageRepo: string;
  imageTag: string;
}): string {
  const { name, port, imageRepo, imageTag } = opts;
  return `apiVersion: kagent.dev/v1alpha1
kind: MCPServer
metadata:
  name: ${name}
  namespace: kagent
  labels:
    backstage.io/kubernetes-id: ${name}
spec:
  transportType: http
  deployment:
    image: ${imageRepo}:${imageTag}
    port: ${port}
    replicas: 1
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 256Mi
  httpTransport:
    path: /mcp
`;
}

function createDeployMcpServerAction() {
  return createTemplateAction({
    id: 'idp:deploy-mcp-server',
    description: 'Apply an MCPServer CRD to the cluster — the kmcp controller deploys it as a pod and makes it available to KAgent agents.',
    schema: {
      input: {
        required: ['name', 'port'],
        type: 'object',
        properties: {
          name: { type: 'string', title: 'MCP server name' },
          port: { type: 'number', title: 'Port', default: 3001 },
          repoName: { type: 'string', title: 'GitHub repo name' },
          repoOwner: { type: 'string', title: 'GitHub repo owner' },
          // No `default` on either: the scaffolder would populate it, and an
          // auto-filled imageTag would always beat commitSha below. Absent
          // means absent, so the precedence order stays meaningful.
          imageTag: {
            type: 'string',
            title: 'Container image tag — overrides commitSha; falls back to "latest"',
          },
          commitSha: {
            type: 'string',
            title: 'Commit SHA to derive an immutable tag from (first 8 chars)',
          },
        },
      },
      output: {
        type: 'object',
        properties: {
          mcpServerName: { type: 'string' },
        },
      },
    },

    async handler(ctx) {
      const name = ctx.input['name'] as string;
      const port = (ctx.input['port'] as number | undefined) ?? 3001;
      const repoName = (ctx.input['repoName'] as string | undefined) ?? name;
      const repoOwner = (ctx.input['repoOwner'] as string | undefined) ?? '';
      // Precedence: an explicit tag, else the scaffold commit shortened to 8
      // chars to match the scaffolded CI's `TAG="${GITHUB_SHA::8}"`, else
      // 'latest'. publish:github emits commitHash as `commitResult?.commitHash`
      // and so can yield undefined — hence the fallback rather than building a
      // dangling "repo:" reference.
      const explicitTag = (ctx.input['imageTag'] as string | undefined)?.trim();
      const commitSha = (ctx.input['commitSha'] as string | undefined)?.trim();
      const imageTag = explicitTag || (commitSha ? commitSha.slice(0, 8) : 'latest');
      if (!explicitTag && !commitSha) {
        ctx.logger.warn(
          'No imageTag or commitSha supplied — falling back to :latest, which is mutable. ' +
            'The scaffolded repo\'s CI will still pin kubernetes/mcpserver.yaml to its own commit SHA.',
        );
      }

      const imageRepo = repoOwner
        ? `ghcr.io/${repoOwner}/${repoName}`
        : `localhost:5003/${name}`;

      ctx.logger.info(`Deploying MCPServer '${name}' to kagent namespace (image: ${imageRepo}:${imageTag})...`);

      // In-cluster (EKS) there is no kubeconfig on disk — write one from the
      // K8S_* env vars first. No-ops when Backstage runs on the host against
      // Kind and the developer's own kubeconfig already applies.
      await ensureKubeconfig();

      try {
        await execAsync('kubectl cluster-info --request-timeout=5s', { env: kubeEnv, timeout: 10_000 });
      } catch (e: any) {
        throw new Error(`Cannot reach the cluster: ${e.message}`);
      }

      const yaml = buildMcpServerYaml({ name, port, imageRepo, imageTag });
      const tmpFile = path.join(os.tmpdir(), `mcpserver-${name}-${Date.now()}.yaml`);

      try {
        await fs.writeFile(tmpFile, yaml, 'utf8');
        const { stdout, stderr } = await execAsync(
          `kubectl apply -f ${tmpFile}`,
          { env: kubeEnv, timeout: 30_000 },
        );
        if (stdout) ctx.logger.info(stdout.trim());
        if (stderr) ctx.logger.warn(stderr.trim());
      } finally {
        await fs.unlink(tmpFile).catch(() => undefined);
      }

      ctx.logger.info(`✓ MCPServer '${name}' applied — kmcp controller will deploy the pod`);
      ctx.logger.info(`  Monitor: kubectl get mcpservers -n kagent`);
      ctx.logger.info(`  To use in an agent, reference: kind: MCPServer, name: ${name}, namespace: kagent`);

      ctx.output('mcpServerName', name);
    },
  });
}

export const idpDeployMcpServerModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-deploy-mcp-server',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createDeployMcpServerAction());
      },
    });
  },
});
