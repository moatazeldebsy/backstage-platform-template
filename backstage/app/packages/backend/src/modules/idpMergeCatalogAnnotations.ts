import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { Config } from '@backstage/config';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import fs from 'fs/promises';

/**
 * Merge annotations into a target repository's existing catalog-info.yaml.
 *
 * The four `enable-*` templates (Datadog APM, Langfuse tracing, security
 * scanning, contract testing) each add instrumentation to somebody *else's*
 * repo, and each ended by printing a README telling the developer to paste a
 * block of annotations into their catalog-info.yaml by hand. Nobody did, which
 * is why no template emitted a single `datadoghq.com/*` annotation and the
 * Datadog entity tab was empty everywhere.
 *
 * A scaffolder skeleton genuinely cannot do this — it can only create files, not
 * merge into one that already exists in a different repository. An action can:
 * fetch the current file over the GitHub API, merge, and write the result into
 * the scaffolder workspace so the template's existing
 * `publish:github:pull-request` step carries it in the same pull request.
 *
 * Deliberately a line-level merge rather than a YAML round-trip. Parsing and
 * re-emitting somebody's catalog-info.yaml would reformat it, drop their
 * comments and reorder their keys — a hostile diff to receive in a PR against
 * your own repo. This inserts only the annotation lines that are missing and
 * leaves every other byte alone.
 */

interface GhFile {
  content: string;
  encoding: string;
  sha: string;
}

async function fetchCatalogInfo(
  owner: string,
  repo: string,
  token: string,
  path: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status} reading ${path}`);
  const json = (await res.json()) as GhFile;
  if (json.encoding !== 'base64') throw new Error(`Unexpected encoding ${json.encoding}`);
  return Buffer.from(json.content, 'base64').toString('utf8');
}

/**
 * Insert annotations under metadata.annotations, preserving everything else.
 * Returns the new content and which keys were actually added.
 */
export function mergeAnnotations(
  original: string,
  annotations: Record<string, string>,
): { content: string; added: string[]; skipped: string[] } {
  const lines = original.split('\n');
  const added: string[] = [];
  const skipped: string[] = [];

  const annIdx = lines.findIndex(l => /^\s*annotations:\s*$/.test(l));
  if (annIdx === -1) {
    // No annotations block. Create one directly under metadata:.
    const metaIdx = lines.findIndex(l => /^metadata:\s*$/.test(l));
    if (metaIdx === -1) {
      throw new Error('catalog-info.yaml has no `metadata:` block — refusing to guess where annotations belong');
    }
    const block = ['  annotations:'];
    for (const [k, v] of Object.entries(annotations)) {
      block.push(`    ${k}: ${JSON.stringify(v)}`);
      added.push(k);
    }
    lines.splice(metaIdx + 1, 0, ...block);
    return { content: lines.join('\n'), added, skipped };
  }

  // Indent of the existing entries, so the insertion matches the file's style.
  const childIndent =
    lines.slice(annIdx + 1).find(l => l.trim() && !l.trim().startsWith('#'))?.match(/^\s*/)?.[0] ??
    `${(lines[annIdx].match(/^\s*/) ?? [''])[0]}  `;

  const insertions: string[] = [];
  for (const [k, v] of Object.entries(annotations)) {
    // Already present anywhere in the file: never overwrite somebody's value.
    if (new RegExp(`^\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').test(original)) {
      skipped.push(k);
      continue;
    }
    insertions.push(`${childIndent}${k}: ${JSON.stringify(v)}`);
    added.push(k);
  }
  if (insertions.length) lines.splice(annIdx + 1, 0, ...insertions);
  return { content: lines.join('\n'), added, skipped };
}

function createMergeAnnotationsAction(config: Config) {
  return createTemplateAction({
    id: 'idp:merge-catalog-annotations',
    description:
      "Fetch a target repository's catalog-info.yaml, merge annotations into it without reformatting the rest, and write it into the workspace so the template's publish step includes it in the same pull request.",
    schema: {
      input: {
        repoUrl: z => z.string().describe('Target repo, as github.com?repo=<repo>&owner=<owner>'),
        annotations: z =>
          z.record(z.string()).describe('Annotation key/value pairs to add'),
        path: z => z.string().optional().describe('Path to catalog-info.yaml (default: catalog-info.yaml)'),
      },
      output: {
        added: z => z.array(z.string()).describe('Annotation keys added'),
        skipped: z => z.array(z.string()).describe('Keys already present and left untouched'),
        merged: z => z.boolean().describe('False when the target has no catalog-info.yaml'),
      },
    },

    async handler(ctx) {
      const { repoUrl, annotations } = ctx.input;
      const path = ctx.input.path ?? 'catalog-info.yaml';

      const params = new URLSearchParams(repoUrl.split('?')[1] ?? '');
      const owner = params.get('owner');
      const repo = params.get('repo');
      if (!owner || !repo) throw new Error(`Could not parse owner/repo from repoUrl: ${repoUrl}`);

      // Config path segments can't index into an array with a numeric
      // segment like 'integrations.github.0.token' — Backstage's ConfigReader
      // treats that as a literal (and invalid) key name and throws "Invalid
      // config key", not a "not found". Fetch the array and index into it.
      const token =
        config.getOptionalConfigArray('integrations.github')?.[0]?.getOptionalString('token') ??
        process.env.GITHUB_TOKEN ??
        '';
      if (!token) throw new Error('No GitHub token available to read the target catalog-info.yaml');

      // Drop empties: templates pass optional annotations unconditionally (a
      // Jinja conditional in the values block is not valid YAML), so an unset
      // optional field arrives as "" and must not become a blank annotation.
      const wanted = Object.fromEntries(
        Object.entries(annotations).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
      );
      if (Object.keys(wanted).length === 0) {
        ctx.logger.info('No non-empty annotations to merge.');
        ctx.output('added', []); ctx.output('skipped', []); ctx.output('merged', false);
        return;
      }

      const original = await fetchCatalogInfo(owner, repo, token, path);
      if (original === null) {
        // Not fatal: the instrumentation PR is still worth opening. Saying so is
        // better than silently producing a PR that looks complete.
        ctx.logger.warn(
          `${owner}/${repo} has no ${path} — skipping the annotation merge. ` +
            'Add the annotations by hand, or register the service in the catalog first.',
        );
        ctx.output('added', []);
        ctx.output('skipped', []);
        ctx.output('merged', false);
        return;
      }

      const { content, added, skipped } = mergeAnnotations(original, wanted);

      const target = resolveSafeChildPath(ctx.workspacePath, path);
      await fs.mkdir(target.substring(0, target.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(target, content, 'utf8');

      if (added.length) ctx.logger.info(`Adding annotations: ${added.join(', ')}`);
      if (skipped.length) {
        ctx.logger.info(`Already set, left untouched: ${skipped.join(', ')}`);
      }

      ctx.output('added', added);
      ctx.output('skipped', skipped);
      ctx.output('merged', true);
    },
  });
}

export const idpMergeCatalogAnnotationsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-merge-catalog-annotations',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        scaffolder.addActions(createMergeAnnotationsAction(config));
      },
    });
  },
});
