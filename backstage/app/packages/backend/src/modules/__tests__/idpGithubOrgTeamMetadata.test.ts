import { ConfigReader } from '@backstage/config';

jest.mock('@backstage/plugin-catalog-backend-module-github', () => ({
  defaultOrganizationTeamTransformer: jest.fn(),
}));

import { buildTeamMetadataTransformer } from '../idpGithubOrgTeamMetadata';
import { defaultOrganizationTeamTransformer } from '@backstage/plugin-catalog-backend-module-github';

const mockDefaultTransformer = defaultOrganizationTeamTransformer as jest.Mock;

function makeGroupEntity(name: string) {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name, annotations: { 'github.com/team-slug': name } },
    spec: { type: 'team', children: [] },
  };
}

describe('idpGithubOrgTeamMetadata / buildTeamMetadataTransformer', () => {
  beforeEach(() => {
    mockDefaultTransformer.mockReset();
  });

  it('merges cost annotations for a team present in catalog.teamMetadata', async () => {
    mockDefaultTransformer.mockResolvedValue(makeGroupEntity('qa-team'));
    const config = new ConfigReader({
      catalog: {
        teamMetadata: {
          'qa-team': { costBudgetMonthlyUsd: '200', costNamespace: 'services-dev' },
        },
      },
    });
    const transformer = buildTeamMetadataTransformer(config);

    const entity = await transformer({} as any, {} as any);

    expect(entity!.metadata.annotations).toMatchObject({
      'github.com/team-slug': 'qa-team',
      'idp.io/cost-budget-monthly-usd': '200',
      'idp.io/cost-namespace': 'services-dev',
    });
  });

  it('leaves the entity untouched when the team has no teamMetadata entry', async () => {
    const base = makeGroupEntity('some-other-team');
    mockDefaultTransformer.mockResolvedValue(base);
    const config = new ConfigReader({
      catalog: { teamMetadata: { 'qa-team': { costBudgetMonthlyUsd: '200' } } },
    });
    const transformer = buildTeamMetadataTransformer(config);

    const entity = await transformer({} as any, {} as any);

    expect(entity!.metadata.annotations).toEqual({ 'github.com/team-slug': 'some-other-team' });
  });

  it('passes through undefined when the default transformer filters the team out', async () => {
    mockDefaultTransformer.mockResolvedValue(undefined);
    const config = new ConfigReader({});
    const transformer = buildTeamMetadataTransformer(config);

    const entity = await transformer({} as any, {} as any);

    expect(entity).toBeUndefined();
  });

  it('is a no-op when catalog.teamMetadata is not configured at all', async () => {
    mockDefaultTransformer.mockResolvedValue(makeGroupEntity('qa-team'));
    const config = new ConfigReader({});
    const transformer = buildTeamMetadataTransformer(config);

    const entity = await transformer({} as any, {} as any);

    expect(entity!.metadata.annotations).toEqual({ 'github.com/team-slug': 'qa-team' });
  });
});
