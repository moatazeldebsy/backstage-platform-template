/**
 * Regression tests for the shared kubeconfig bootstrap.
 *
 * The bug these lock down: idpDeployModelServer used to read
 * `K8S_CLUSTER_CA_B64`, a name nothing in this repo ever sets, so every AWS
 * model-server deploy threw before doing any work. Every producer
 * (terraform/secrets.tf, aws/backstage/deployment.yaml,
 * scripts/get-k8s-credentials.sh) writes `K8S_CLUSTER_CA_DATA`.
 */

const mockWriteFile = jest.fn();
jest.mock('fs/promises', () => ({ writeFile: (...a: any[]) => mockWriteFile(...a) }));

const K8S_VARS = [
  'K8S_CLUSTER_URL',
  'K8S_SERVICE_ACCOUNT_TOKEN',
  'K8S_CLUSTER_CA_DATA',
  'K8S_CLUSTER_CA_B64',
  'KUBECONFIG',
];

describe('ensureKubeconfig', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    jest.resetModules();
    mockWriteFile.mockReset();
    saved = Object.fromEntries(K8S_VARS.map(k => [k, process.env[k]]));
    K8S_VARS.forEach(k => delete process.env[k]);
  });

  afterEach(() => {
    K8S_VARS.forEach(k => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    });
  });

  const load = () => require('../kubeconfig');

  it('no-ops when the K8S_* vars are absent (local dev, host kubeconfig)', async () => {
    await load().ensureKubeconfig();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('reads the CA from K8S_CLUSTER_CA_DATA, not K8S_CLUSTER_CA_B64', async () => {
    process.env.K8S_CLUSTER_URL = 'https://eks.example.com';
    process.env.K8S_SERVICE_ACCOUNT_TOKEN = 'tok';
    process.env.K8S_CLUSTER_CA_DATA = 'Q0FEQVRB';

    await load().ensureKubeconfig();

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, contents] = mockWriteFile.mock.calls[0];
    expect(contents).toContain('certificate-authority-data: Q0FEQVRB');
    expect(contents).toContain('server: https://eks.example.com');
    expect(contents).toContain('token: tok');
  });

  it('pins the CA rather than skipping TLS verification', async () => {
    process.env.K8S_CLUSTER_URL = 'https://eks.example.com';
    process.env.K8S_SERVICE_ACCOUNT_TOKEN = 'tok';
    process.env.K8S_CLUSTER_CA_DATA = 'Q0FEQVRB';

    await load().ensureKubeconfig();

    const [, contents] = mockWriteFile.mock.calls[0];
    expect(contents).not.toContain('insecure-skip-tls-verify');
  });

  it('throws a named error when the URL and token are set but the CA is not', async () => {
    process.env.K8S_CLUSTER_URL = 'https://eks.example.com';
    process.env.K8S_SERVICE_ACCOUNT_TOKEN = 'tok';

    await expect(load().ensureKubeconfig()).rejects.toThrow('K8S_CLUSTER_CA_DATA');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('ignores the old K8S_CLUSTER_CA_B64 name', async () => {
    process.env.K8S_CLUSTER_URL = 'https://eks.example.com';
    process.env.K8S_SERVICE_ACCOUNT_TOKEN = 'tok';
    process.env.K8S_CLUSTER_CA_B64 = 'OLDNAME';

    await expect(load().ensureKubeconfig()).rejects.toThrow('K8S_CLUSTER_CA_DATA');
  });

  it('writes the kubeconfig 0600 — it carries a service account token', async () => {
    process.env.K8S_CLUSTER_URL = 'https://eks.example.com';
    process.env.K8S_SERVICE_ACCOUNT_TOKEN = 'tok';
    process.env.K8S_CLUSTER_CA_DATA = 'Q0FEQVRB';

    await load().ensureKubeconfig();

    const [path, , opts] = mockWriteFile.mock.calls[0];
    expect(path).toBe('/tmp/kubeconfig');
    expect(opts).toMatchObject({ mode: 0o600 });
  });

  it('honours an explicit KUBECONFIG path', async () => {
    process.env.KUBECONFIG = '/custom/kubeconfig';
    process.env.K8S_CLUSTER_URL = 'https://eks.example.com';
    process.env.K8S_SERVICE_ACCOUNT_TOKEN = 'tok';
    process.env.K8S_CLUSTER_CA_DATA = 'Q0FEQVRB';

    const mod = load();
    await mod.ensureKubeconfig();

    expect(mockWriteFile.mock.calls[0][0]).toBe('/custom/kubeconfig');
    expect(mod.kubeEnv.KUBECONFIG).toBe('/custom/kubeconfig');
  });
});

describe('AI scaffolder actions bootstrap the kubeconfig', () => {
  // The agent and MCPServer actions previously had no ensureKubeconfig() at
  // all, so in-cluster on EKS they ran kubectl against a /tmp/kubeconfig that
  // does not exist. The RBAC granted to them was unusable as a result.
  it.each([
    'idpDeployAgent',
    'idpDeployMcpServer',
    'idpDeployModelServer',
    'idpRunTrainingJob',
    'idpSetupContractTesting',
  ])('%s imports the shared kubeconfig helper', moduleName => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    // __dirname is .../modules/__tests__, so the modules sit one level up.
    const src = fs.readFileSync(
      path.join(__dirname, '..', `${moduleName}.ts`),
      'utf8',
    );
    expect(src).toMatch(/from '\.\/kubeconfig'/);
    expect(src).toContain('ensureKubeconfig');
    // and must not carry a private copy that can drift again
    expect(src).not.toMatch(/async function ensureKubeconfig/);
    expect(src).not.toContain('insecure-skip-tls-verify');
    expect(src).not.toContain('K8S_CLUSTER_CA_B64');
  });
});
