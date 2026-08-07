// Shared by every FE repo on this machine, because `signup/ip/long` allows only 5 mints per hour per
// IP: a cache per repo spends that budget once per repo, and the second one may 429.
// Keyed by resolved host, because the repos resolve their base URL asymmetrically — RN falls back to
// dev, merchant's `NEXT_PUBLIC_API_URL` has no default and fails closed — so a region-only key hands
// one repo the other environment's token, failing as a confusing 401 rather than loudly.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CACHE_DIR_VAR = 'HP_FIXTURE_TOKEN_DIR';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Anything outside this would compose a filename, and a region carrying a path separator writes
// outside the cache directory entirely.
const REGION_PATTERN = /^[a-z0-9_-]+$/i;

const resolveCacheDir = cacheDir =>
  cacheDir ??
  process.env[CACHE_DIR_VAR] ??
  path.join(homedir(), '.heroplus', 'fixture-tokens');

/** Where this host and region's token lives. Exported so a human can be told, and nothing else. */
export function cachePathFor({ baseUrl, region, cacheDir }) {
  let host;
  try {
    // `.host`, not `.hostname`: the port belongs to the key, which is what keeps two local stubs on
    // different ports from sharing one token.
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    throw new Error(
      `The fixture token cache is keyed by resolved host, and ${JSON.stringify(baseUrl)} is not a URL.`
    );
  }

  if (!REGION_PATTERN.test(String(region ?? '')))
    throw new Error(
      `Region ${JSON.stringify(region)} cannot key a cache file — use letters, digits, _ or - only.`
    );

  return path.join(
    resolveCacheDir(cacheDir),
    `${host.replace(/[^a-z0-9.-]/g, '_')}--${String(region).toUpperCase()}.tok`
  );
}

/** The full `Bearer <jwt>` string, or `null` when nothing is cached for this host and region. */
export function readCachedToken({ baseUrl, region, cacheDir } = {}) {
  const target = cachePathFor({ baseUrl, region, cacheDir });
  try {
    const contents = readFileSync(target, 'utf8').trim();
    return contents === '' ? null : contents;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function writeCachedToken({ baseUrl, region, cacheDir, authorization }) {
  // Validated rather than normalised, so a caller holding a bare JWT is told rather than quietly
  // corrected — `withFreshToken` is where the two shapes are reconciled.
  if (!/^Bearer\s+\S/.test(String(authorization ?? '')))
    throw new Error(
      'writeCachedToken stores the full `Bearer <jwt>` string, and was given something else.'
    );

  const target = cachePathFor({ baseUrl, region, cacheDir });
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // `mkdirSync`'s mode is masked by the umask and ignored outright on a directory that already
  // existed, so neither call alone guarantees a credential store other users cannot list.
  chmodSync(dir, DIR_MODE);

  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, String(authorization).trim(), { mode: FILE_MODE });
    chmodSync(temp, FILE_MODE);
    // Two repos can be recapturing at once, so a sibling must see the old token or the whole new
    // one, never a partial write.
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }

  return target;
}

export function invalidateCachedToken({ baseUrl, region, cacheDir } = {}) {
  const target = cachePathFor({ baseUrl, region, cacheDir });
  rmSync(target, { force: true });
  return target;
}
