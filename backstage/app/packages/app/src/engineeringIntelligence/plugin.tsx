import {
  FrontendPlugin,
  PageBlueprint,
  createFrontendPlugin,
  createRouteRef,
} from '@backstage/frontend-plugin-api';
import InsightsIcon from '@material-ui/icons/Assessment';
import DashboardIcon from '@material-ui/icons/Dashboard';

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
// so any PageBlueprint with a `title` and `icon` lands in the alphabetical
// scroll area on its own.

export const engineeringIntelligenceRouteRef = createRouteRef();

const engineeringIntelligencePage = PageBlueprint.make({
  name: 'engineering-intelligence',
  params: {
    title: 'Engineering Intelligence',
    icon: <InsightsIcon fontSize="inherit" />,
    path: '/engineering-intelligence',
    routeRef: engineeringIntelligenceRouteRef,
    loader: () =>
      import('./EngineeringIntelligencePage').then(m => (
        <m.EngineeringIntelligencePage />
      )),
  },
});

export const core4RouteRef = createRouteRef();

// The leadership view of the same collection, in DX Core 4 terms. Its own page
// rather than a section of the one above: that page is for the platform team
// working the evidence, this one is the four numbers leadership reviews.
const core4Page = PageBlueprint.make({
  name: 'core4',
  params: {
    title: 'DX Core 4',
    icon: <DashboardIcon fontSize="inherit" />,
    path: '/core4',
    routeRef: core4RouteRef,
    loader: () => import('./Core4Page').then(m => <m.Core4Page />),
  },
});

// The explicit FrontendPlugin annotation mirrors customPagesPlugin's, and for
// the same reason: without it TypeScript emits a nondeterministic TS2742 from a
// hoisted nested @backstage/catalog-model.
export const engineeringIntelligencePlugin: FrontendPlugin = createFrontendPlugin({
  pluginId: 'engineering-intelligence',
  routes: { root: engineeringIntelligenceRouteRef, core4: core4RouteRef },
  extensions: [engineeringIntelligencePage, core4Page],
});
