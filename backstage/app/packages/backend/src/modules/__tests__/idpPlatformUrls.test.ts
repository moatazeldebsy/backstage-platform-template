import type { ActionContext } from '@backstage/plugin-scaffolder-node';
import type { Config } from '@backstage/config';
import { createPlatformUrlsAction } from '../idpPlatformUrls';

function makeConfig(values: Record<string, string>): Config {
  return {
    getOptionalString: (key: string) => values[key],
  } as unknown as Config;
}

function makeCtx() {
  const outputs: Record<string, unknown> = {};
  const ctx = {
    input: {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    output: (name: string, value: unknown) => {
      outputs[name] = value;
    },
  } as unknown as ActionContext<any, any, any>;
  return { ctx, outputs };
}

describe('idp:platform-urls', () => {
  it('falls back to the *.idp.local defaults when no config is set', async () => {
    const action = createPlatformUrlsAction(makeConfig({}));
    const { ctx, outputs } = makeCtx();
    await action.handler(ctx);

    expect(outputs).toEqual({
      grafana: 'http://grafana.idp.local',
      argocd: 'http://argocd.idp.local',
      backstage: 'http://backstage.idp.local',
      kagent: 'http://kagent.idp.local',
      mlflow: 'http://mlflow.idp.local',
      langfuse: 'http://langfuse.idp.local',
      prometheus: 'http://prometheus.idp.local',
    });
  });

  it('prefers externalLinks.<key> over the default for non-backstage keys', async () => {
    const action = createPlatformUrlsAction(makeConfig({
      'externalLinks.grafana': 'https://grafana.prod.example.com',
    }));
    const { ctx, outputs } = makeCtx();
    await action.handler(ctx);

    expect(outputs.grafana).toBe('https://grafana.prod.example.com');
  });

  it('prefers app.baseUrl over externalLinks.backstage, which is preferred over the default', async () => {
    const action = createPlatformUrlsAction(makeConfig({
      'app.baseUrl': 'https://backstage.prod.example.com',
      'externalLinks.backstage': 'https://backstage.other.example.com',
    }));
    const { ctx, outputs } = makeCtx();
    await action.handler(ctx);

    expect(outputs.backstage).toBe('https://backstage.prod.example.com');
  });

  it('falls back to externalLinks.backstage when app.baseUrl is unset', async () => {
    const action = createPlatformUrlsAction(makeConfig({
      'externalLinks.backstage': 'https://backstage.other.example.com',
    }));
    const { ctx, outputs } = makeCtx();
    await action.handler(ctx);

    expect(outputs.backstage).toBe('https://backstage.other.example.com');
  });

  it('strips a trailing slash so templates can append paths without doubling it', async () => {
    const action = createPlatformUrlsAction(makeConfig({
      'externalLinks.grafana': 'https://grafana.prod.example.com/',
    }));
    const { ctx, outputs } = makeCtx();
    await action.handler(ctx);

    expect(outputs.grafana).toBe('https://grafana.prod.example.com');
  });
});
