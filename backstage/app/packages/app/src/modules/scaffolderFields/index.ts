import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { FormFieldBlueprint } from '@backstage/plugin-scaffolder-react/alpha';

// Custom scaffolder form fields. Templates use them via `ui:field: <name>`.
export const scaffolderFieldsModule = createFrontendModule({
  pluginId: 'scaffolder',
  extensions: [
    FormFieldBlueprint.make({
      name: 'new-repo-url-picker',
      params: {
        field: () => import('./NewRepoUrlPicker').then(m => m.NewRepoUrlPicker),
      },
    }),
  ],
});
