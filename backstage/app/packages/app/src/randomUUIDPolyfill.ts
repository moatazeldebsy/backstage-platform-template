// crypto.randomUUID() for insecure contexts.
//
// Browsers only expose crypto.randomUUID on secure origins (HTTPS or
// localhost). The local portal is served over plain HTTP at
// backstage.idp.local, so it is undefined there — and Backstage's
// PermissionClient calls it to tag every authorize request. The call threw
// before any request was sent, every permission check resolved to "not
// allowed", and permission-gated pages broke silently: the Kubernetes tab
// showed "Permission required" and /catalog-import rendered a 404 (its
// RequirePermission wrapper falls back to the NotFound page). The backend
// policy was allowing both all along.
//
// crypto.getRandomValues has no secure-context restriction, so an RFC 4122
// v4 UUID built from it is equivalent. Remove once local ingress serves
// HTTPS (#310).

export function randomUUIDFromValues(
  getRandomValues: (array: Uint8Array) => Uint8Array,
): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function installRandomUUIDPolyfill(target: { crypto?: Crypto } = globalThis): void {
  const c = target.crypto;
  if (!c || typeof c.randomUUID === 'function') return;
  Object.defineProperty(c, 'randomUUID', {
    value: () => randomUUIDFromValues(a => c.getRandomValues(a)),
    configurable: true,
    writable: true,
  });
}

installRandomUUIDPolyfill();
