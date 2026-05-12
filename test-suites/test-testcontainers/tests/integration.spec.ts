import { GenericContainer, Wait } from 'testcontainers';

describe('hello-service integration', () => {
  const stopped: Array<{ stop: () => Promise<void> }> = [];
  afterAll(async () => { await Promise.all(stopped.map((c) => c.stop())); });

  test('postgres container starts', async () => {
    const pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
      .withExposedPorts(5432)
      .start();
    stopped.push(pg);

    expect(pg.getMappedPort(5432)).toBeGreaterThan(0);
    // Add your service integration assertions here
  });
});
