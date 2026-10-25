import { installRandomUUIDPolyfill, randomUUIDFromValues } from './randomUUIDPolyfill';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUUID polyfill', () => {
  it('builds RFC 4122 v4 UUIDs from random bytes', () => {
    expect(randomUUIDFromValues(a => a.fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(randomUUIDFromValues(a => a.fill(0))).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('installs randomUUID where an insecure context leaves it undefined', () => {
    const target = { crypto: { getRandomValues: (a: Uint8Array) => a.fill(7) } as unknown as Crypto };
    installRandomUUIDPolyfill(target);
    expect(target.crypto.randomUUID()).toMatch(V4);
  });

  it('leaves a native randomUUID alone', () => {
    const native = () => 'native' as any;
    const target = { crypto: { randomUUID: native, getRandomValues: jest.fn() } as unknown as Crypto };
    installRandomUUIDPolyfill(target);
    expect(target.crypto.randomUUID).toBe(native);
  });
});
