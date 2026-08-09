/**
 * Ambient types for `libsodium-wrappers`.
 *
 * The package's package.json advertises `"types": "dist/modules/libsodium-wrappers.d.ts"`,
 * but that file is not actually shipped in the installed version — `dist/modules/`
 * contains only the .js. Its `exports` map also has no `types` condition, so under
 * `moduleResolution: bundler` TypeScript resolves the import to the ESM build and
 * finds no declarations either way. `@types/libsodium-wrappers` does not help: it is
 * a stub package whose entire content is a note saying the library provides its own
 * types.
 *
 * So the import was implicitly `any`, which `noImplicitAny` rejects. Rather than
 * suppress it, this declares the small surface the backend actually uses — sealed-box
 * encryption of GitHub Actions secrets in idpSetRepoSecrets.ts. Getting the signature
 * wrong here would be caught at the call site, which an `any` never would.
 *
 * Delete this file if the upstream package starts shipping real declarations.
 */
declare module 'libsodium-wrappers' {
  /** Resolves once the WASM/asm.js backend has finished initialising. */
  export const ready: Promise<void>;

  /**
   * Anonymous ("sealed box") public-key encryption — libsodium's
   * crypto_box_seal. GitHub requires repository secrets to be sealed against
   * the repo's public key before upload.
   */
  export function crypto_box_seal(
    message: Uint8Array,
    publicKey: Uint8Array,
  ): Uint8Array;

  const sodium: {
    ready: Promise<void>;
    crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  };
  export default sodium;
}
