import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The core developer-portal flow: find a service in the catalog and open its entity page.
test('a developer finds hello-service in the catalog and opens it', { session: 'guest' }, async ({ app, agent, screen, browser }) => {
  await app.open('/catalog');
  await expect(screen.getByRole('heading', { name: /IDP Developer Portal|Catalog/ }).first()).toBeVisible({ timeout: 20_000 });

  await agent.act('filter the catalog to find the component named hello-service, then open its page');
  await expect(browser).toHaveURL(/\/catalog\/default\/component\/hello-service/);
  // The header heading's accessible name also carries the "Add to favorites" star.
  await expect(screen.getByRole('heading', { name: /^hello-service/ })).toBeVisible();
  await expect(screen.getByRole('tab', { name: 'Overview' })).toBeVisible();
  await expect(screen.getByRole('heading', { name: 'About' })).toBeVisible();
  await expect(screen.getByText('Reference Go service').first()).toBeVisible();
  await expect(screen.getByRole('link', { name: 'Platform Team' }).first()).toBeVisible();

  await agent.assert('the About card says hello-service is owned by Platform Team');
});
