import {
  FrontendPlugin,
  NavItemBlueprint,
  PageBlueprint,
  createFrontendPlugin,
  createRouteRef,
} from '@backstage/frontend-plugin-api';
import InsightsIcon from '@material-ui/icons/Assessment';

// The first custom frontend plugin in this repo to live outside extensions.tsx.
//
// Every other custom page is declared in that one 7,700-line file, which is why
// its pure logic had to be extracted into scorecard.ts before it could be tested
// at all — importing extensions.tsx into a test loads every plugin and takes
// minutes. This module keeps its page, its client and its presentation logic
// together in a directory instead, so the tests next door run in milliseconds.
//
// Registered in App.tsx's `features` array alongside customPagesPlugin. The nav
// sidebar needs no change: Sidebar.tsx renders `nav.rest({ sortBy: 'title' })`,
// so a NavItemBlueprint from any plugin lands in the alphabetical scroll area on
// its own.

export const engineeringIntelligenceRouteRef = createRouteRef();

const engineeringIntelligencePage = PageBlueprint.make({
  name: 'engineering-intelligence',
  params: {
    path: '/engineering-intelligence',
    routeRef: engineeringIntelligenceRouteRef,
    loader: () =>
      import('./EngineeringIntelligencePage').then(m => (
        <m.EngineeringIntelligencePage />
      )),
  },
});

const engineeringIntelligenceNavItem = NavItemBlueprint.make({
  name: 'engineering-intelligence',
  params: {
    title: 'Engineering Intelligence',
    icon: InsightsIcon as any,
    routeRef: engineeringIntelligenceRouteRef,
  },
});

// The explicit FrontendPlugin annotation mirrors customPagesPlugin's, and for
// the same reason: without it TypeScript emits a nondeterministic TS2742 from a
// hoisted nested @backstage/catalog-model.
export const engineeringIntelligencePlugin: FrontendPlugin = createFrontendPlugin({
  pluginId: 'engineering-intelligence',
  routes: { root: engineeringIntelligenceRouteRef },
  extensions: [engineeringIntelligencePage, engineeringIntelligenceNavItem],
});
