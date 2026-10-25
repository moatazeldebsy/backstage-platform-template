import {
  FrontendPlugin,
  PageBlueprint,
  createFrontendPlugin,
  createRouteRef,
} from '@backstage/frontend-plugin-api';
import FeedbackIcon from '@material-ui/icons/Feedback';

// The DevEx survey page, laid out like engineeringIntelligence/: page, client
// and pure form logic in one directory, outside extensions.tsx, so its tests
// run in milliseconds. Lands in the sidebar on its own via its title and icon.

export const devexSurveyRouteRef = createRouteRef();

const devexSurveyPage = PageBlueprint.make({
  name: 'devex-survey',
  params: {
    title: 'DevEx Survey',
    icon: <FeedbackIcon fontSize="inherit" />,
    path: '/devex-survey',
    routeRef: devexSurveyRouteRef,
    loader: () => import('./DevexSurveyPage').then(m => <m.DevexSurveyPage />),
  },
});

// Explicit annotation for the same TS2742 reason as engineeringIntelligencePlugin.
export const devexSurveyPlugin: FrontendPlugin = createFrontendPlugin({
  pluginId: 'devex-survey',
  routes: { root: devexSurveyRouteRef },
  extensions: [devexSurveyPage],
});
