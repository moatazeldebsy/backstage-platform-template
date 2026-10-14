import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('app opens', async ({ app, browser }) => {
  await app.open('/');
  await expect(browser.locator('body')).toBeVisible();
});

// With the model key in the environment, uncomment:
// test('the agent drives a flow', async ({ app, agent }) => {
//   await app.open('/');
//   await agent.act('one goal in natural language');
//   await agent.assert('one question about the screen');
// });
