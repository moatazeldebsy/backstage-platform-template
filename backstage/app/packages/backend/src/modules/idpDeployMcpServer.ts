import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node/alpha';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

const kubeEnv = {
  ...process.env,
  KUBECONFIG: process.env.KUBECONFIG ?? '/tmp/kubeconfig',
};

function buildMcpServerYaml(opts: {
  name: string;
  port: number;
  imageRepo: string;
}): string {
  const { name, port, imageRepo } = opts;
  return `apiVersion: kagent.dev/v1alpha2
kind: MCPServer
metadata:
  name: ${name}
  namespace: kagent
  labels:
    backstage.io/kubernetes-id: ${name}
spec:
  transportType: http
  deployment:
    image: ${imageRepo}:latest
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

      const imageRepo = repoOwner
        ? `ghcr.io/${repoOwner}/${repoName}`
        : `localhost:5003/${name}`;

      ctx.logger.info(`Deploying MCPServer '${name}' to kagent namespace (image: ${imageRepo})...`);

      try {
        await execAsync('kubectl cluster-info --request-timeout=5s', { env: kubeEnv });
      } catch (e: any) {
        throw new Error(`Cannot reach the Kind cluster: ${e.message}`);
      }

      const yaml = buildMcpServerYaml({ name, port, imageRepo });
      const tmpFile = path.join(os.tmpdir(), `mcpserver-${name}-${Date.now()}.yaml`);

      try {
        await fs.writeFile(tmpFile, yaml, 'utf8');
        const { stdout, stderr } = await execAsync(
          `kubectl apply -f ${tmpFile}`,
          { env: kubeEnv },
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
