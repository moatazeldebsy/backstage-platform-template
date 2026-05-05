import { browser } from '@wdio/globals';

describe('${{ values.targetService }} mobile smoke', () => {
  it('app launches without errors', async () => {
    const source = await browser.getPageSource();
    expect(source).toBeTruthy();
  });
});
