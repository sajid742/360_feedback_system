/**
 * Build-time licensing constants.
 *
 * WHY THIS FILE EXISTS. The two decisions that licensing hangs on — *which public key do
 * I trust* and *is the development licence available* — used to be read from environment
 * variables at runtime. On an on-premise install the customer owns that environment, so
 * both were a one-line edit of a text file. They now live here, and this file is compiled
 * into `dist`, so changing either means editing built JavaScript inside a shipped image
 * rather than editing `.env`.
 *
 * That does not make the software uncrackable — the customer has root on the box — but it
 * turns a config tweak into a deliberate, technical modification of a delivered artefact.
 *
 * THE VALUES BELOW ARE THE DEVELOPMENT DEFAULTS and are committed on purpose, so a fresh
 * clone builds and `npm run dev` works with no key at all. A release build overwrites them
 * inside the Docker build context via `scripts/write-build-config.cjs`; your working tree
 * is never touched.
 *
 * NOTE: the trusted key is a PUBLIC key. There is nothing secret in this file, and there
 * never must be — the private signing key lives outside the repository, outside every
 * image and outside every customer package, and that must not change.
 */

export type BuildChannel =
  /** Local development. Development licence available, LICENSE_PUBLIC_KEY honoured. */
  | 'internal'
  /** CI. Behaves like a customer build so tests exercise real licence behaviour. */
  | 'test'
  /** Anything that leaves the building. Development licence compiled out, key baked in. */
  | 'customer';

/* --- generated block: scripts/write-build-config.cjs rewrites the three lines below --- */
export const BUILD_CHANNEL = 'internal' as BuildChannel;
export const TRUSTED_PUBLIC_KEY_B64 = '';
export const BUILD_ID = 'dev';
/* --- end generated block --- */

/** True only for local development. Everything else is treated as a shipped build. */
export const isInternalBuild = (): boolean => BUILD_CHANNEL === 'internal';
