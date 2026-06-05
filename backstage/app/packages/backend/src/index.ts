/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';
import { idpLocalDeployModule } from './modules/idpLocalDeploy';
import { idpProvisionSecretModule } from './modules/idpProvisionSecret';
import { idpSetRepoSecretsModule } from './modules/idpSetRepoSecrets';
import { idpTechInsightsModule } from './modules/idpTechInsights';
import { idpDeployAgentModule } from './modules/idpDeployAgent';
import { idpRunTrainingJobModule } from './modules/idpRunTrainingJob';
import { idpDeployMcpServerModule } from './modules/idpDeployMcpServer';
import { idpDeployModelServerModule } from './modules/idpDeployModelServer';
import { idpSetupContractTestingModule } from './modules/idpSetupContractTesting';
import { ragSearchPlugin } from './modules/idpRagSearch';
import { idpPermissionPolicyModule } from './modules/idpPermissionPolicy';


const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(idpLocalDeployModule);
backend.add(idpProvisionSecretModule);
backend.add(idpSetRepoSecretsModule);
backend.add(idpTechInsightsModule);
backend.add(idpDeployAgentModule);
backend.add(idpRunTrainingJobModule);
backend.add(idpDeployMcpServerModule);
backend.add(idpDeployModelServerModule);
backend.add(idpSetupContractTestingModule);
backend.add(ragSearchPlugin);

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
backend.add(import('@backstage/plugin-auth-backend-module-github-provider'));

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));

// permission plugin — guests get read-only access; authenticated users get full access
backend.add(import('@backstage/plugin-permission-backend'));
backend.add(idpPermissionPolicyModule);

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin
backend.add(import('@backstage/plugin-kubernetes-backend'));

// tech insights plugin
backend.add(import('@backstage-community/plugin-tech-insights-backend'));

// announcements plugin
backend.add(import('@backstage-community/plugin-announcements-backend'));

// notifications plugin
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-notifications'));

// adr plugin
backend.add(import('@backstage-community/plugin-adr-backend'));

// tech radar plugin
backend.add(import('@backstage-community/plugin-tech-radar-backend'));

backend.start();
