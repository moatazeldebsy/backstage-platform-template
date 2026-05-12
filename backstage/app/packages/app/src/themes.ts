import React from 'react';
import { createUnifiedTheme, palettes, UnifiedThemeProvider } from '@backstage/theme';
import type { AppTheme } from '@backstage/frontend-plugin-api';

// ── IDP Dark ────────────────────────────────────────────────────────────────
const idpDarkUnifiedTheme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    primary: { main: '#7df3e1' },
    secondary: { main: '#56ccf2' },
    background: { default: '#0d1117', paper: '#161b22' },
    navigation: {
      background: '#0d1117',
      indicator: '#7df3e1',
      color: '#8b949e',
      selectedColor: '#ffffff',
      navItem: { hoverBackground: '#21262d' },
      submenu: { background: '#161b22' },
    },
    text: { primary: '#e6edf3', secondary: '#8b949e' },
    link: '#7df3e1',
    linkHover: '#56ccf2',
  },
});

// ── Catppuccin Mocha ─────────────────────────────────────────────────────────
const catppuccinUnifiedTheme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    primary: { main: '#cba6f7' },
    secondary: { main: '#89b4fa' },
    background: { default: '#1e1e2e', paper: '#313244' },
    navigation: {
      background: '#181825',
      indicator: '#cba6f7',
      color: '#bac2de',
      selectedColor: '#cdd6f4',
      navItem: { hoverBackground: '#313244' },
      submenu: { background: '#1e1e2e' },
    },
    text: { primary: '#cdd6f4', secondary: '#bac2de' },
    link: '#89b4fa',
    linkHover: '#cba6f7',
  },
});

// ── Nord ─────────────────────────────────────────────────────────────────────
const nordUnifiedTheme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    primary: { main: '#88c0d0' },
    secondary: { main: '#81a1c1' },
    background: { default: '#2e3440', paper: '#3b4252' },
    navigation: {
      background: '#2e3440',
      indicator: '#88c0d0',
      color: '#d8dee9',
      selectedColor: '#eceff4',
      navItem: { hoverBackground: '#434c5e' },
      submenu: { background: '#3b4252' },
    },
    text: { primary: '#eceff4', secondary: '#d8dee9' },
    link: '#88c0d0',
    linkHover: '#81a1c1',
  },
});

// ── Dracula ───────────────────────────────────────────────────────────────────
const draculaUnifiedTheme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    primary: { main: '#bd93f9' },
    secondary: { main: '#ff79c6' },
    background: { default: '#282a36', paper: '#44475a' },
    navigation: {
      background: '#21222c',
      indicator: '#bd93f9',
      color: '#f8f8f2',
      selectedColor: '#ffffff',
      navItem: { hoverBackground: '#44475a' },
      submenu: { background: '#282a36' },
    },
    text: { primary: '#f8f8f2', secondary: '#6272a4' },
    link: '#8be9fd',
    linkHover: '#bd93f9',
  },
});

// ── AppTheme objects ──────────────────────────────────────────────────────────

export const idpDarkTheme: AppTheme = {
  id: 'idp-dark',
  title: 'IDP Dark',
  variant: 'dark',
  Provider: ({ children }) =>
    React.createElement(UnifiedThemeProvider, { theme: idpDarkUnifiedTheme, children }),
};

export const catppuccinTheme: AppTheme = {
  id: 'catppuccin',
  title: 'Catppuccin Mocha',
  variant: 'dark',
  Provider: ({ children }) =>
    React.createElement(UnifiedThemeProvider, { theme: catppuccinUnifiedTheme, children }),
};

export const nordTheme: AppTheme = {
  id: 'nord',
  title: 'Nord',
  variant: 'dark',
  Provider: ({ children }) =>
    React.createElement(UnifiedThemeProvider, { theme: nordUnifiedTheme, children }),
};

export const draculaTheme: AppTheme = {
  id: 'dracula',
  title: 'Dracula',
  variant: 'dark',
  Provider: ({ children }) =>
    React.createElement(UnifiedThemeProvider, { theme: draculaUnifiedTheme, children }),
};
