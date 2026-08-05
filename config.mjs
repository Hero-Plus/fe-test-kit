// The one specifier every check reaches host config through. A package cannot know the adopting
// repo's layout, so the repo names its own path module on HP_FIXTURES_CONFIG and this file resolves
// it.
//
// Every name is re-exported, core and per-check alike, because ESM cannot re-export from a dynamic
// specifier. A name outside the host's enabled checks is legitimately `undefined` here — which is
// safe only because `loadHostConfig` refuses a host whose *enabled* checks are missing one.
import { HostConfigError, loadHostConfig } from './lib/host-config.mjs';

let host;
try {
  host = await loadHostConfig();
} catch (err) {
  // `process.exit` here cannot be caught by an importer, and a bare throw exits 1 with a stack
  // trace over the message that says what to fix. Arming the handler on this path only keeps both:
  // an importer that awaits this module inside try/catch still wins the rejection, and an unrelated
  // crash in a repo whose config loaded fine never meets a handler at all.
  process.once('uncaughtException', fatal => {
    if (!(fatal instanceof HostConfigError)) throw fatal;
    console.error(`\n${fatal.message}`);
    process.exit(2);
  });
  throw err;
}

export const absolute = host.absolute;
export const CAPTURED_ORIGIN = host.CAPTURED_ORIGIN;
export const CELL_MANIFEST = host.CELL_MANIFEST;
export const CELL_MANIFEST_RELATIVE = host.CELL_MANIFEST_RELATIVE;
export const CHECKS = host.CHECKS;
export const CORPUS_ROOT_FILES = host.CORPUS_ROOT_FILES;
export const CORPUS_ROOT_SUFFIXES = host.CORPUS_ROOT_SUFFIXES;
export const enumerateCells = host.enumerateCells;
export const FIXTURES_DIR = host.FIXTURES_DIR;
export const FIXTURES_RELATIVE = host.FIXTURES_RELATIVE;
export const listCaptures = host.listCaptures;
export const ORIGIN_RELATIVE = host.ORIGIN_RELATIVE;
export const PAN_ALLOWLIST = host.PAN_ALLOWLIST;
export const PAN_ALLOWLIST_RELATIVE = host.PAN_ALLOWLIST_RELATIVE;
export const readBody = host.readBody;
export const REPO_ROOT = host.REPO_ROOT;
export const RULE_EXEMPTIONS_RELATIVE = host.RULE_EXEMPTIONS_RELATIVE;
export const SCRIPTS = host.SCRIPTS;
export const TOOLS_RELATIVE = host.TOOLS_RELATIVE;
export const TRANSACTION_TABLES = host.TRANSACTION_TABLES;
export const TRANSACTION_TABLES_RELATIVE = host.TRANSACTION_TABLES_RELATIVE;
