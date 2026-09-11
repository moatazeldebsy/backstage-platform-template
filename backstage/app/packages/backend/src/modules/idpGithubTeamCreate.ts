/**
 * IDP scaffolder action: idp:github:team-create
 *
 * Creates (or reuses) a GitHub Org Team as part of the `team-namespace`
 * template, and optionally seeds it with initial members. GitHub Org Teams
 * are now the source of truth for Backstage Group entities — the
 * `catalogModuleGithubOrgEntityProvider` (see idpGithubOrgTeamMetadata.ts)
 * syncs every org team into the catalog on its own schedule, so this action
 * is the only step this template needs for "create the team"; there is no
 * more hand-generated catalog Group YAML to publish alongside it.
 *
 * Idempotent: if the team already exists (GitHub returns 422 on create),
 * the existing team is looked up and reused rather than failing the run —
 * re-running the template for an existing team name should not error.
 */
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { ScmIntegrations } from '@backstage/integration';
import { getGithubApiHeaders, summarizeSettledResults } from './githubRepoHelpers';

interface GithubTeam {
  id: number;
  slug: string;
  html_url: string;
}

export function createGithubTeamCreateAction(options: { integrations: ScmIntegrations }) {
  return createTemplateAction({
    id: 'idp:github:team-create',
    description:
      'Create a GitHub Org Team (or reuse it if it already exists), optionally nested under a parent team, and seed it with initial members.',
    schema: {
      input: {
        org: z => z.string().describe('GitHub organization login'),
        teamName: z => z.string().describe('Team slug/name to create'),
        description: z => z.string().optional().describe('Team description'),
        parentTeamSlug: z =>
          z.string().optional().describe('Slug of an existing team to nest this team under'),
        initialMembers: z =>
          z.array(z.string()).optional().describe('GitHub logins to add as members on creation'),
        // Any repo under `org` works for token resolution when the platform
        // integration is a PAT (the common case here) — see getGithubApiHeaders.
        platformRepo: z => z.string().describe('A repo under `org` used to resolve API credentials'),
      },
      output: {
        teamSlug: z => z.string(),
        teamUrl: z => z.string(),
        created: z => z.boolean().describe('False when the team already existed and was reused'),
        membersAdded: z => z.array(z.string()),
      },
    },

    async handler(ctx) {
      const { org, teamName, description, parentTeamSlug, platformRepo } = ctx.input;
      const initialMembers = ctx.input.initialMembers ?? [];

      const headers = await getGithubApiHeaders(options.integrations, org, platformRepo);

      let parentTeamId: number | undefined;
      if (parentTeamSlug) {
        const parentResp = await fetch(
          `https://api.github.com/orgs/${org}/teams/${parentTeamSlug}`,
          { headers },
        );
        if (parentResp.ok) {
          parentTeamId = ((await parentResp.json()) as GithubTeam).id;
        } else {
          ctx.logger.warn(
            `Parent team "${parentTeamSlug}" not found in org "${org}" (status ${parentResp.status}) — creating "${teamName}" as a top-level team instead.`,
          );
        }
      }

      ctx.logger.info(`Creating GitHub team "${teamName}" in org "${org}"...`);
      const createResp = await fetch(`https://api.github.com/orgs/${org}/teams`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: teamName,
          description,
          privacy: 'closed',
          ...(parentTeamId ? { parent_team_id: parentTeamId } : {}),
        }),
      });

      let team: GithubTeam;
      let created: boolean;
      if (createResp.status === 201) {
        team = (await createResp.json()) as GithubTeam;
        created = true;
      } else if (createResp.status === 422) {
        ctx.logger.info(`Team "${teamName}" already exists in org "${org}" — reusing it.`);
        const existingResp = await fetch(
          `https://api.github.com/orgs/${org}/teams/${teamName}`,
          { headers },
        );
        if (!existingResp.ok) {
          const body = await existingResp.text();
          throw new Error(
            `Team "${teamName}" reported as already existing (422) but could not be fetched (${existingResp.status}): ${body}`,
          );
        }
        team = (await existingResp.json()) as GithubTeam;
        created = false;
      } else {
        const body = await createResp.text();
        throw new Error(`Failed to create team "${teamName}" (${createResp.status}): ${body}`);
      }

      const settled = await Promise.allSettled(
        initialMembers.map(async username => {
          const resp = await fetch(
            `https://api.github.com/orgs/${org}/teams/${team.slug}/memberships/${username}`,
            { method: 'PUT', headers, body: JSON.stringify({ role: 'member' }) },
          );
          if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`status=${resp.status}: ${body}`);
          }
          return username;
        }),
      );
      const membersAdded = summarizeSettledResults(
        settled,
        initialMembers.map(m => [m, m]),
        'Member',
        `${org}/${team.slug}`,
        ctx.logger,
      );

      ctx.logger.info(
        `Team "${team.slug}" ${created ? 'created' : 'reused'}. Members added: ${membersAdded.join(', ') || '(none)'}.`,
      );

      ctx.output('teamSlug', team.slug);
      ctx.output('teamUrl', team.html_url);
      ctx.output('created', created);
      ctx.output('membersAdded', membersAdded);
    },
  });
}

export const idpGithubTeamCreateModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-github-team-create',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        const integrations = ScmIntegrations.fromConfig(config);
        scaffolder.addActions(createGithubTeamCreateAction({ integrations }));
      },
    });
  },
});
