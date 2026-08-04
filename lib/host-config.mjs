// Split from `config.mjs` for testability, not layering: config.mjs resolves at module scope, so a
// test importing it gets one attempt per process and cannot reach the failure branches.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_VAR = 'HP_FIXTURES_CONFIG';

// The one canonical copy of the contract. ESM cannot re-export from a dynamic specifier, so
// `config.mjs` spells all 16 out a second time; `config-test.mjs` is what keeps the copies equal.
export const CONFIG_NAMES = Object.freeze([
  'absolute',
  'CELL_MANIFEST',
  'CELL_MANIFEST_RELATIVE',
  'CORPUS_ROOT_FILES',
  'CORPUS_ROOT_SUFFIXES',
  'FIXTURES_DIR',
  'FIXTURES_RELATIVE',
  'LIST_PAGE_RELATIVE',
  'LIST_ROWS_KEY',
  'ORIGIN_RELATIVE',
  'PAN_ALLOWLIST',
  'PAN_ALLOWLIST_RELATIVE',
  'REPO_ROOT',
  'TOOLS_RELATIVE',
  'TRANSACTION_TABLES',
  'TRANSACTION_TABLES_RELATIVE',
]);

export class HostConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostConfigError';
  }
}

export async function loadHostConfig() {
  const spec = process.env[CONFIG_VAR];
  if (!spec)
    throw new HostConfigError(
      `${CONFIG_VAR} is not set. Point it at this repo's fixture-path module — the ES module ` +
        `exporting the ${CONFIG_NAMES.length} names these checks read. Setting it once on the ` +
        'verify entry point reaches every check, which inherits the environment.'
    );

  const resolved = path.resolve(spec);
  let host;
  try {
    host = await import(pathToFileURL(resolved).href);
  } catch (err) {
    throw new HostConfigError(
      `${CONFIG_VAR}=${spec} resolved to ${resolved}, which could not be imported — ${err.message}`
    );
  }

  // Compared against `undefined` rather than tested with `in`, because a dynamic import degrades a
  // name the host never exported into `undefined` instead of raising the load error a static import
  // would have. A check handed `undefined` for a corpus path takes its skip branch and exits 0,
  // which `verify.mjs` tallies as a pass.
  const missing = CONFIG_NAMES.filter(name => host[name] === undefined);
  if (missing.length > 0)
    throw new HostConfigError(
      `${CONFIG_VAR} resolved ${resolved}, but it exports no value for ${missing.length} of the ` +
        `${CONFIG_NAMES.length} required names: ${missing.join(', ')}.`
    );

  return host;
}
