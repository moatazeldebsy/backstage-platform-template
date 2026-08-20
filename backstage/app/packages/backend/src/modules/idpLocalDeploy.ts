import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// Exec timeouts (ms). Surfaces a clear error instead of hanging the scaffolder
// step forever when helm / kubectl / docker can't reach their endpoints.
const EXEC_TIMEOUT_FAST_MS = 10_000;   // quick version/status checks
const EXEC_TIMEOUT_DEPLOY_MS = 120_000; // helm upgrade --install can take a while on cold image pulls
const EXEC_TIMEOUT_DOCKER_MS = 180_000; // docker pull/push for large images

// Always pass KUBECONFIG explicitly so child processes use the rewritten
// kubeconfig (host.docker.internal + insecure-skip-tls-verify) written at
// container startup by the docker-compose command.
const kubeEnv = {
  ...process.env,
  KUBECONFIG: process.env.KUBECONFIG ?? '/tmp/kubeconfig',
};

function createDeployLocalAction() {
  return createTemplateAction({
    id: 'idp:deploy-local',
    description:
      'Deploy a scaffolded service to the local Kind cluster via Helm.',
    schema: {
      input: {
        serviceName: z =>
          z.string().describe('Name of the service to deploy (must match the Helm release name)'),
        namespace: z => z.string().optional().describe('Kubernetes namespace (default: services)'),
        imageTag: z => z.string().optional().describe('Image tag (default: latest)'),
        helmChartPath: z =>
          z.string().optional().describe('Absolute path to the helm chart inside the container (default: /helm/service-template)'),
        registry: z => z.string().optional().describe('Local registry (default: localhost:5003)'),
      },
      output: {
        serviceUrl: z => z.string().describe('Service URL'),
        releaseStatus: z => z.string().describe('Helm Release Status'),
      },
    },
    async handler(ctx) {
      const {
        serviceName,
        namespace = 'services',
        imageTag = 'latest',
        helmChartPath = '/helm/service-template',
        registry = 'localhost:5003',
      } = ctx.input;

      ctx.logger.info(
        `Deploying ${serviceName}:${imageTag} to Kind (namespace: ${namespace})`,
      );

      // Verify helm is available
      try {
        const { stdout } = await execAsync('helm version --short', { env: kubeEnv, timeout: EXEC_TIMEOUT_FAST_MS });
        ctx.logger.info(`helm: ${stdout.trim()}`);
      } catch (e: any) {
        throw new Error(
          `helm is not available in the Backstage container: ${e.message}. ` +
            'Ensure the backend Dockerfile installs helm.',
        );
      }

      // Verify kubeconfig / cluster is reachable
      try {
        const { stdout } = await execAsync(
          'kubectl cluster-info --request-timeout=5s',
          { env: kubeEnv, timeout: EXEC_TIMEOUT_FAST_MS },
        );
        ctx.logger.info(`Cluster: ${stdout.split('\n')[0]}`);
      } catch (e: any) {
        throw new Error(
          `Cannot reach the Kind cluster (KUBECONFIG=${kubeEnv.KUBECONFIG}): ${e.message}. ` +
            'Ensure the kubeconfig is mounted and the Kind cluster is running.',
        );
      }

      const imageRef = `${registry}/${serviceName}`;

      ctx.logger.info(
        `Running: helm upgrade --install ${serviceName} ${helmChartPath} ` +
          `--namespace ${namespace} --set image.repository=${imageRef} --set image.tag=${imageTag}`,
      );

      const { stdout: helmOut, stderr: helmErr } = await execAsync(
        [
          `helm upgrade --install ${serviceName}`,
          helmChartPath,
          `--namespace ${namespace}`,
          `--create-namespace`,
          `--set image.repository=${imageRef}`,
          `--set image.tag=${imageTag}`,
          `--set replicaCount=1`,
          `--set ingress.enabled=true`,
          `--set ingress.className=nginx`,
          `--set "ingress.hosts[0].host=${serviceName}.idp.local"`,
          `--set "ingress.hosts[0].paths[0].path=/"`,
          `--set "ingress.hosts[0].paths[0].pathType=Prefix"`,
          `--set resources.requests.cpu=50m`,
          `--set resources.requests.memory=32Mi`,
          `--set resources.limits.cpu=200m`,
          `--set resources.limits.memory=128Mi`,
        ].join(' '),
        { env: kubeEnv, timeout: EXEC_TIMEOUT_DEPLOY_MS },
      );

      if (helmOut) ctx.logger.info(helmOut);
      if (helmErr) ctx.logger.warn(helmErr);

      // Show pod status (informational — not a blocking check)
      try {
        const { stdout: pods } = await execAsync(
          `kubectl get pods -n ${namespace} -l app.kubernetes.io/instance=${serviceName} --no-headers`,
          { env: kubeEnv, timeout: EXEC_TIMEOUT_FAST_MS },
        );
        ctx.logger.info(`Pod status:\n${pods || '(no pods yet — image may still be pulling)'}`);
      } catch {
        ctx.logger.warn('Could not fetch pod status — check kubectl manually.');
      }

      const serviceUrl = `http://${serviceName}.idp.local`;
      ctx.logger.info(`✓ ${serviceName} is live at ${serviceUrl}`);

      ctx.output('serviceUrl', serviceUrl);
      ctx.output('releaseStatus', 'deployed');
    },
  });
}

// Seed a placeholder image for a newly scaffolded service so ArgoCD can deploy
// it without hitting ImagePullBackOff.  Runs: docker tag + docker push using the
// Docker socket mounted from the host.  The source image (hello-service:local)
// is used as a stand-in until the service's own CI pipeline pushes a real image.
//
// From inside the Docker container, the host registry (localhost:5003) is reachable
// as host.docker.internal:5003 — same physical registry, different hostname.
function createSeedImageAction() {
  return createTemplateAction({
    id: 'idp:seed-image',
    description:
      'Tag and push a placeholder image to the local Kind registry for a new service. ' +
      'Prevents ImagePullBackOff on first ArgoCD deploy.',
    schema: {
      input: {
        serviceName: z => z.string().describe('Service name'),
        registry: z =>
          z.string().optional().describe('Local registry as seen from the host (default: localhost:5003)'),
        sourceImage: z =>
          z.string().optional().describe('Existing image in the local registry to use as placeholder (default: hello-service:local)'),
      },
    },
    async handler(ctx) {
      const {
        serviceName,
        registry = 'localhost:5003',
        sourceImage = 'hello-service:local',
      } = ctx.input;

      // Inside the container, host's localhost:5003 is host.docker.internal:5003
      const hostRegistry = registry.replace('localhost', 'host.docker.internal');
      const src = `${hostRegistry}/${sourceImage}`;
      const dest = `${hostRegistry}/${serviceName}:latest`;

      ctx.logger.info(`Seeding image: ${src} → ${dest}`);

      try {
        // Pull source from host registry into the container's Docker daemon
        const { stdout: pullOut } = await execAsync(`docker pull ${src}`, { timeout: EXEC_TIMEOUT_DOCKER_MS });
        if (pullOut) ctx.logger.info(pullOut.trim());

        await execAsync(`docker tag ${src} ${dest}`, { timeout: EXEC_TIMEOUT_FAST_MS });
        ctx.logger.info(`Tagged ${src} → ${dest}`);

        const { stdout: pushOut } = await execAsync(`docker push ${dest}`, { timeout: EXEC_TIMEOUT_DOCKER_MS });
        if (pushOut) ctx.logger.info(pushOut.trim());

        ctx.logger.info(
          `✓ Image seeded at ${dest}. ArgoCD will pull it as ${registry}/${serviceName}:latest`,
        );
      } catch (e: any) {
        // Non-fatal — ArgoCD will just retry until the real image is pushed
        ctx.logger.warn(
          `Could not seed image (Docker socket may not be mounted): ${e.message}. ` +
            `Run manually: docker tag ${registry}/${sourceImage} ${registry}/${serviceName}:latest && ` +
            `docker push ${registry}/${serviceName}:latest`,
        );
      }
    },
  });
}

// Register a scaffolded entity directly into the local catalog by writing its
// catalog-info.yaml to the bind-mounted /catalog/scaffolded/<name>/ directory
// and POSTing a Location entity to the catalog API.
//
// Why: in local-only mode (no real GITHUB_TOKEN) `publish:github` and the
// subsequent `catalog:register` both silently fail — see `continueOnError: true`
// in the service templates — and the scaffolded entity never appears in the
// catalog. This action gives the templates a GitHub-free registration path so
// the new Component shows up after every local scaffold.
function createCatalogRegisterLocalAction() {
  return createTemplateAction({
    id: 'idp:catalog-register-local',
    description:
      'Write a catalog-info.yaml to the local catalog directory and register ' +
      'it with the Backstage catalog API. Use this in local-only mode where ' +
      'publish:github + catalog:register cannot run.',
    schema: {
      input: {
        entityName: z => z.string().describe('Entity name'),
        entityKind: z => z.string().optional().describe('Entity kind (default: Component)'),
        entityType: z =>
          z.string().optional().describe('Spec type — service/library/website/… (default: service)'),
        owner: z => z.string().optional().describe('Owner (default: platform-team)'),
        description: z => z.string().optional().describe('Description'),
        namespace: z => z.string().optional().describe('Backstage namespace (default: default)'),
        annotations: z => z.record(z.string()).optional().describe('Extra metadata.annotations'),
        catalogRootDir: z =>
          z.string().optional().describe('Bind-mounted catalog dir inside the container (default: /catalog/scaffolded)'),
        backstageUrl: z =>
          z.string().optional().describe('Backstage backend URL used to POST the new Location (default: http://localhost:7007)'),
      },
      output: {
        entityRef: z => z.string().describe('Entity reference of the registered component'),
        catalogInfoPath: z => z.string().describe('Path of the written catalog-info.yaml'),
      },
    },
    async handler(ctx) {
      const {
        entityName,
        entityKind = 'Component',
        entityType = 'service',
        owner = 'platform-team',
        description = '',
        namespace = 'default',
        annotations = {},
        catalogRootDir = '/catalog/scaffolded',
        backstageUrl = 'http://localhost:7007',
      } = ctx.input;

      const entityDir = path.join(catalogRootDir, entityName);
      const catalogInfoPath = path.join(entityDir, 'catalog-info.yaml');

      // YAML built by hand — no yaml dependency needed, the shape is fixed.
      const annotationLines = Object.entries(annotations)
        .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
        .join('\n');
      const yaml = `${[
        'apiVersion: backstage.io/v1alpha1',
        `kind: ${entityKind}`,
        'metadata:',
        `  name: ${entityName}`,
        `  namespace: ${namespace}`,
        description ? `  description: ${JSON.stringify(description)}` : '',
        annotationLines ? '  annotations:' : '',
        annotationLines,
        'spec:',
        `  type: ${entityType}`,
        `  lifecycle: experimental`,
        `  owner: ${owner}`,
      ]
        .filter(Boolean)
        .join('\n')}\n`;

      await fs.mkdir(entityDir, { recursive: true });
      await fs.writeFile(catalogInfoPath, yaml, 'utf8');
      ctx.logger.info(`Wrote ${catalogInfoPath}`);

      // POST a Location entity to the catalog so it picks the file up
      // immediately (rather than waiting for the next refresh tick).
      const locationsUrl = `${backstageUrl}/api/catalog/locations`;
      const body = JSON.stringify({
        type: 'file',
        target: catalogInfoPath,
      });
      try {
        const res = await fetch(locationsUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (!res.ok && res.status !== 409) {
          // 409 = already registered (idempotent re-scaffold)
          const text = await res.text();
          ctx.logger.warn(
            `Catalog location POST returned ${res.status}: ${text}`,
          );
        } else {
          ctx.logger.info(
            `Registered catalog location (status=${res.status}) for ${entityName}`,
          );
        }
      } catch (e: any) {
        ctx.logger.warn(
          `Could not POST catalog location: ${e.message}. The next catalog ` +
            `refresh tick will still pick up the file.`,
        );
      }

      const entityRef = `${entityKind.toLowerCase()}:${namespace}/${entityName}`;
      ctx.output('entityRef', entityRef);
      ctx.output('catalogInfoPath', catalogInfoPath);
    },
  });
}

export const idpLocalDeployModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-local-deploy',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
      },
      async init({ scaffolder }) {
        scaffolder.addActions(createDeployLocalAction());
        scaffolder.addActions(createSeedImageAction());
        scaffolder.addActions(createCatalogRegisterLocalAction());
      },
    });
  },
});
