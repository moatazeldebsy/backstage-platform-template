// checkConsent() reads APPROVAL_SERVICE_URL at module load, so exercising both
// "deployed" and "not deployed" behaviour needs a fresh module instance per
// test (jest.resetModules() + require, not the top-level import the other
// suites use against the single test-env module instance).

jest.mock('node-fetch', () => {
  const mockFetch = jest.fn();
  return { default: mockFetch, __esModule: true };
});

const ORIGINAL_ENV = process.env;

function makeResponse(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

beforeEach(() => {
  jest.resetModules();
  jest.resetAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('checkConsent (approval-service not deployed)', () => {
  it('always grants — fails open, same shape as check_policy/request_approval', async () => {
    delete process.env.APPROVAL_SERVICE_URL;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkConsent } = require('../server.js') as typeof import('../server.js');
    const result = await checkConsent('user:default/jane', 'idp-assistant', 'scaffold_service');
    expect(result).toEqual({ granted: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect((require('node-fetch') as { default: jest.Mock }).default).not.toHaveBeenCalled();
  });
});

describe('checkConsent (approval-service deployed, no verified user)', () => {
  it('always grants when userRef is empty — nothing to check consent for', async () => {
    process.env.APPROVAL_SERVICE_URL = 'http://approval-service:4000';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkConsent } = require('../server.js') as typeof import('../server.js');
    const result = await checkConsent('', 'idp-assistant', 'scaffold_service');
    expect(result).toEqual({ granted: true });
  });
});

describe('checkConsent (approval-service deployed, verified user)', () => {
  it('queries GET /consent/check and returns approval-service\'s answer', async () => {
    process.env.APPROVAL_SERVICE_URL = 'http://approval-service:4000';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkConsent } = require('../server.js') as typeof import('../server.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fetchMock = (require('node-fetch') as { default: jest.Mock }).default;
    fetchMock.mockResolvedValueOnce(makeResponse({ granted: false }));

    const result = await checkConsent('user:default/jane', 'idp-assistant', 'scaffold_service');

    expect(result).toEqual({ granted: false });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('http://approval-service:4000/consent/check?');
    expect(calledUrl).toContain('user_ref=user%3Adefault%2Fjane');
    expect(calledUrl).toContain('agent=idp-assistant');
    expect(calledUrl).toContain('scope=scaffold_service');
  });

  it('throws on a non-ok response, same as the other approval-service proxies', async () => {
    process.env.APPROVAL_SERVICE_URL = 'http://approval-service:4000';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkConsent } = require('../server.js') as typeof import('../server.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fetchMock = (require('node-fetch') as { default: jest.Mock }).default;
    fetchMock.mockResolvedValueOnce(makeResponse('boom', 500));

    await expect(checkConsent('user:default/jane', 'idp-assistant', 'scaffold_service')).rejects.toThrow('approval-service error 500');
  });
});
