import { GenericContainer, Wait } from 'testcontainers';

describe('${{ values.targetService }} integration tests', () => {
  // Containers are started once per describe block for speed
  let containers: Array<{ stop: () => Promise<void> }> = [];

  afterAll(async () => {
    await Promise.all(containers.map((c) => c.stop()));
  });

  test('postgres container starts and accepts connections', async () => {
    const postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
      .withExposedPorts(5432)
      .start();

    containers.push(postgres);

    const host = postgres.getHost();
    const port = postgres.getMappedPort(5432);
    expect(host).toBeTruthy();
    expect(port).toBeGreaterThan(0);

    // Replace this with your actual service integration logic:
    // e.g. run migrations, seed data, call your service, assert DB state
  });
});
