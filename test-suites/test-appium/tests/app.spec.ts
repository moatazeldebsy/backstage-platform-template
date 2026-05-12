import { browser } from '@wdio/globals';

describe('hello-service mobile smoke', () => {
  it('app launches', async () => {
    expect(await browser.getPageSource()).toBeTruthy();
  });
});
