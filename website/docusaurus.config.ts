import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import {themes as prismThemes} from 'prism-react-renderer';

// Public docs site. It reads the same ../docs folder that mkdocs.yml renders
// in the Backstage TechDocs tab, so pages must stay plain Markdown that both
// renderers understand.
const repoUrl = 'https://github.com/moatazeldebsy/backstage-platform-template';

const config: Config = {
  title: 'Internal Developer Platform',
  tagline: 'Golden-path platform for building and deploying services on EKS',

  url: 'https://moatazeldebsy.github.io',
  baseUrl: '/backstage-platform-template/',
  // Keeps MkDocs' /page/ URLs, so existing inbound links still resolve.
  trailingSlash: true,

  organizationName: 'moatazeldebsy',
  projectName: 'backstage-platform-template',
  deploymentBranch: 'gh-pages',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'warn',

  markdown: {
    // .md files are CommonMark, not MDX: several pages contain GitHub Actions
    // `${{ ... }}` snippets and bare `<` that MDX would reject.
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: `${repoUrl}/edit/main/docs/`,
          exclude: ['postmortems/**', 'diagrams/**'],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        docsDir: '../docs',
        docsRouteBasePath: '/',
        indexBlog: false,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Internal Developer Platform',
      logo: {alt: '', src: 'img/logo.svg'},
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {
          // pathname:// skips route checking: /demo/ is a static file, not a doc.
          href: 'pathname:///demo/',
          label: 'Live Demo',
          position: 'left',
          target: '_blank',
        },
        {href: repoUrl, label: 'GitHub', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      copyright: `Internal Developer Platform · <a href="${repoUrl}">${repoUrl.replace('https://', '')}</a>`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'hcl', 'docker', 'diff', 'ini', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
