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

function buildAgentYaml(opts: {
  name: string;
  description: string;
  modelConfig: string;
  enableCatalogSearch: boolean;
  enableMetrics: boolean;
  enableScaffolding: boolean;
}): string {
  const { name, description, modelConfig, enableCatalogSearch, enableMetrics, enableScaffolding } = opts;
  const hasTools = enableCatalogSearch || enableMetrics || enableScaffolding;

  const toolNames: string[] = [];
  if (enableCatalogSearch) toolNames.push('catalog_search');
  if (enableMetrics) toolNames.push('get_service_metrics');
  if (enableScaffolding) toolNames.push('scaffold_service', 'list_deployments');

  const toolsBlock = hasTools
    ? `    tools:
      - type: McpServer
        mcpServer:
          kind: RemoteMCPServer
          name: idp-mcp-server
          namespace: kagent
          toolNames:
${toolNames.map(t => `            - ${t}`).join('\n')}`
    : `    tools: []`;

  return `apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: ${name}
  namespace: kagent
  labels:
    backstage.io/kubernetes-id: ${name}
spec:
  type: Declarative
  description: "${description.replace(/"/g, '\\"')}"
  declarative:
    modelConfig: ${modelConfig}
    systemMessage: |
      You are ${name}, an AI agent running on the Internal Developer Platform.
      ${description}

      You help engineers by providing accurate, concise answers.
      Always cite which tool you used to retrieve information.
${toolsBlock}
`;
}

function createDeployAgentAction() {
  return createTemplateAction({
    id: 'idp:deploy-agent',
    description: 'Apply a KAgent Agent CRD to the local Kind cluster so the agent is immediately visible in the KAgent UI.',
    schema: {
      input: {
        required: ['name', 'description'],
        type: 'object',
        properties: {
          name: { type: 'string', title: 'Agent name' },
          description: { type: 'string', title: 'Agent description' },
          modelProvider: { type: 'string', title: 'Model provider', default: 'anthropic' },
          enableCatalogSearch: { type: 'boolean', title: 'Enable catalog search tool', default: true },
          enableMetrics: { type: 'boolean', title: 'Enable metrics tool', default: true },
          enableScaffolding: { type: 'boolean', title: 'Enable scaffolding tool', default: false },
        },
      },
      output: {
        type: 'object',
        properties: {
          agentUrl: { type: 'string', title: 'KAgent UI URL' },
        },
      },
    },

    async handler(ctx) {
      const name = ctx.input['name'] as string;
      const description = ctx.input['description'] as string;
      const modelProvider = (ctx.input['modelProvider'] as string | undefined) ?? 'anthropic';
      const enableCatalogSearch = (ctx.input['enableCatalogSearch'] as boolean | undefined) ?? true;
      const enableMetrics = (ctx.input['enableMetrics'] as boolean | undefined) ?? true;
      const enableScaffolding = (ctx.input['enableScaffolding'] as boolean | undefined) ?? false;

      const modelConfig = modelProvider === 'openai' ? 'openai-prod'
        : modelProvider === 'anthropic' ? 'claude-anthropic'
        : 'claude-anthropic';

      ctx.logger.info(`Deploying Agent '${name}' to kagent namespace (modelConfig: ${modelConfig})...`);

      // Verify cluster is reachable
      try {
        await execAsync('kubectl cluster-info --request-timeout=5s', { env: kubeEnv });
      } catch (e: any) {
        throw new Error(`Cannot reach the Kind cluster: ${e.message}`);
      }

      const yaml = buildAgentYaml({ name, description, modelConfig, enableCatalogSearch, enableMetrics, enableScaffolding });

      const tmpFile = path.join(os.tmpdir(), `agent-${name}-${Date.now()}.yaml`);
      try {
        await fs.writeFile(tmpFile, yaml, 'utf8');
        const { stdout, stderr } = await execAsync(`kubectl apply -f ${tmpFile}`, { env: kubeEnv });
        if (stdout) ctx.logger.info(stdout.trim());
        if (stderr) ctx.logger.warn(stderr.trim());
      } finally {
        await fs.unlink(tmpFile).catch(() => undefined);
      }

      ctx.logger.info(`✓ Agent '${name}' is live — open http://kagent.idp.local to chat with it`);
      ctx.output('agentUrl', 'http://kagent.idp.local');
    },
  });
}

export const idpDeployAgentModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-deploy-agent',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createDeployAgentAction());
      },
    });
  },
});
