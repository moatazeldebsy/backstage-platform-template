// Shared harness for testing plugin routers without a running backend: mount
// the router on a bare Express app on an ephemeral port, with a fake httpAuth
// and an error handler standing in for Backstage's (auth failures -> 401).
import express, { Router } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { HttpAuthService } from '@backstage/backend-plugin-api';

/** Header the fake httpAuth treats as "a verified Backstage user session". */
export const TEST_USER_HEADER = 'x-test-verified-user';

/**
 * Stand-in for coreServices.httpAuth: a request is authenticated as the user in
 * TEST_USER_HEADER, and anything without it is refused the way the real
 * service refuses a missing or non-user credential.
 */
export function fakeHttpAuth(): HttpAuthService {
  return {
    credentials: jest.fn(async (req: express.Request) => {
      const userEntityRef = req.get(TEST_USER_HEADER);
      if (!userEntityRef) {
        const err = new Error('Missing user credentials');
        err.name = 'AuthenticationError';
        throw err;
      }
      return { $$type: '@backstage/BackstageCredentials', principal: { type: 'user', userEntityRef } };
    }),
    issueUserCookie: jest.fn(),
  } as unknown as HttpAuthService;
}

export async function serve(router: Router): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(router);
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = err.name === 'AuthenticationError' || err.name === 'NotAllowedError' ? 401 : 500;
      res.status(status).json({ error: err.name });
    },
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
