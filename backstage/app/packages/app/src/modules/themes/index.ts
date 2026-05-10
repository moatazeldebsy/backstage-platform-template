import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { ThemeBlueprint } from '@backstage/plugin-app-react';
import { idpDarkTheme, catppuccinTheme, nordTheme, draculaTheme } from '../../themes';

export const themesModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    ThemeBlueprint.make({ name: 'idp-dark',   params: { theme: idpDarkTheme } }),
    ThemeBlueprint.make({ name: 'catppuccin', params: { theme: catppuccinTheme } }),
    ThemeBlueprint.make({ name: 'nord',       params: { theme: nordTheme } }),
    ThemeBlueprint.make({ name: 'dracula',    params: { theme: draculaTheme } }),
  ],
});
