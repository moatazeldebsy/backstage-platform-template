import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Local Backstage uses guest auth (app-config.local.yaml); sign in once and share the session.
test.setup('sign in as guest', { sessions: ['guest'] }, async ({ app, screen, session }) => {
  await app.open('/');
  await screen.getByRole('listitem').filter({ hasText: 'Guest' }).getByRole('button', { name: 'Enter' }).click();
  await expect(screen.getByRole('link', { name: 'Catalog' }).first()).toBeVisible({ timeout: 20_000 });
  await session.save('guest');
});
