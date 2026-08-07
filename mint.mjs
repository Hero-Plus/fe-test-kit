#!/usr/bin/env node
// Ensures a usable fixture token is cached for one host and region, and prints the cache path.
//
// It never prints the token, and there is deliberately no flag that does: minting runs inline in an
// orchestrated session, so this process's stdout is a transcript. Consumers read the value with
// `readCachedToken` from `lib/mint.mjs`.
import { resolveAccount } from './lib/fixture-accounts.mjs';
import {
  assertMintableHost,
  cachePathFor,
  mintToken,
  readCachedToken,
  writeCachedToken,
} from './lib/mint.mjs';
import { FAILED, setupError } from './lib/outcomes.mjs';

const CHECK = 'hp-fixtures-mint';

const USAGE = `${CHECK} --base-url <url> --region <TH|HK|MY> [--cache-dir <dir>] [--force]

Mints a merchant fixture token if none is cached, and prints the cache file path.

  --base-url   required, and guarded: production is refused
  --region     required; selects the account, and keys the cache with the resolved host
  --cache-dir  overrides HP_FIXTURE_TOKEN_DIR and the ~/.heroplus/fixture-tokens default
  --force      mints even when a token is cached, spending one of 5 mints per hour per IP`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--force') {
      flags.force = true;
      continue;
    }
    if (!arg.startsWith('--'))
      setupError(CHECK, `unexpected argument ${arg}\n\n${USAGE}`);

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      setupError(CHECK, `${arg} needs a value\n\n${USAGE}`);

    flags[arg.slice(2).replace(/-(\w)/g, (_, letter) => letter.toUpperCase())] =
      value;
    i += 1;
  }
  return flags;
}

const { help, baseUrl, region, cacheDir, force } = parseArgs(
  process.argv.slice(2)
);

if (help) {
  console.log(USAGE);
  process.exit(0);
}
if (!baseUrl || !region)
  setupError(CHECK, `--base-url and --region are both required\n\n${USAGE}`);

const key = { baseUrl, region, cacheDir };

let account;
try {
  assertMintableHost(baseUrl);
  account = resolveAccount(region);
} catch (err) {
  setupError(CHECK, err.message);
}

try {
  if (!force && readCachedToken(key)) {
    process.stderr.write(`${CHECK}: reusing the cached ${region} token\n`);
    console.log(cachePathFor(key));
    process.exit(0);
  }

  process.stderr.write(`${CHECK}: minting a ${region} token\n`);
  const authorization = await mintToken({ baseUrl, account });
  console.log(writeCachedToken({ ...key, authorization }));
} catch (err) {
  console.error(`\n${CHECK}: ${err.message}`);
  process.exit(FAILED);
}
