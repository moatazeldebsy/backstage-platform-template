import React from 'react';
import { createApp } from '@backstage/frontend-defaults';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import scaffolderPlugin from '@backstage/plugin-scaffolder/alpha';
import searchPlugin from '@backstage/plugin-search/alpha';
import userSettingsPlugin from '@backstage/plugin-user-settings/alpha';
import orgPlugin from '@backstage/plugin-org/alpha';
import apiDocsPlugin from '@backstage/plugin-api-docs/alpha';
import catalogGraphPlugin from '@backstage/plugin-catalog-graph/alpha';
import catalogImportPlugin from '@backstage/plugin-catalog-import/alpha';
import techdocsPlugin from '@backstage/plugin-techdocs/alpha';
import kubernetesPlugin from '@backstage/plugin-kubernetes/alpha';
import githubActionsPlugin from '@backstage-community/plugin-github-actions/alpha';
import announcementsPlugin from '@backstage-community/plugin-announcements/alpha';
import adrPlugin from '@backstage-community/plugin-adr/alpha';
import techRadarPlugin from '@backstage-community/plugin-tech-radar/alpha';

import { SignInPage } from '@backstage/core-components';
import { githubAuthApiRef } from '@backstage/core-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { navModule } from './modules/nav';
import { themesModule } from './modules/themes';
import { customPagesPlugin } from './extensions';

// Override the default sign-in page to add GitHub provider alongside Guest.
// Using createFrontendModule (targeting pluginId: 'app') avoids the version
// mismatch caused by @backstage/frontend-defaults bundling its own copy of
// @backstage/plugin-app. The module contributes to the existing plugin
// without replacing it.
const appSignInModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    SignInPageBlueprint.make({
      params: {
        loader: async () => (props: any) =>
          React.createElement(SignInPage, {
            ...props,
            providers: [
              'guest',
              {
                id: 'github-auth-provider',
                title: 'GitHub',
                message: 'Sign in with your GitHub account',
                apiRef: githubAuthApiRef,
              },
            ],
          }),
      },
    }),
  ],
});

export default createApp({
  features: [
    customPagesPlugin,
    catalogPlugin,
    scaffolderPlugin,
    searchPlugin,
    userSettingsPlugin,
    orgPlugin,
    apiDocsPlugin,
    catalogGraphPlugin,
    catalogImportPlugin,
    techdocsPlugin,
    kubernetesPlugin,
    githubActionsPlugin,
    announcementsPlugin,
    adrPlugin,
    techRadarPlugin,
    navModule,
    themesModule,
    appSignInModule,
  ],
});
