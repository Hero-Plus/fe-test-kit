// The three dev merchant logins every FE repo recaptures against. It lives in the kit rather than in
// each repo's `tools/fixtures/` because the table is repo-invariant — the same three accounts,
// whichever repo asks — and a copy per repo is the two-implementations-that-drift shape this package
// exists to prevent.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * TH is a live *production* merchant login as well as a dev one — `APP_REVIEW_PHONE` /
 * `APP_REVIEW_OTP` are set as production env properties for a real merchant — which is why
 * `assertMintableHost` exists. Pointed at production, this table signs in to that merchant.
 */
export const DEFAULT_ACCOUNTS = Object.freeze({
  TH: Object.freeze({
    countryCode: '+66',
    phone: '866666666',
    code: '111111',
    locale: 'en-TH',
  }),
  HK: Object.freeze({
    countryCode: '+852',
    phone: '98999999',
    code: '111111',
    locale: 'en-HK',
  }),
  MY: Object.freeze({
    countryCode: '+60',
    phone: '162856899',
    code: '111111',
    locale: 'en-MY',
  }),
});

// Read per call rather than at import, so setting the variable cannot depend on module load order.
const machineAccountsFile = () =>
  process.env.HP_FIXTURE_ACCOUNTS_FILE ??
  path.join(homedir(), '.heroplus', 'fixture-accounts.json');

const FIELDS = Object.freeze(['countryCode', 'phone', 'code', 'locale']);

function readMachineAccounts(file) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  // A credential file every user on the box can read is worth one line, not a refusal: the operator
  // put it there deliberately and refusing would strand the substitution this order exists to allow.
  if ((statSync(file).mode & 0o077) !== 0)
    process.stderr.write(
      `[fixtures] ${file} is readable beyond its owner — chmod 600 it.\n`
    );

  try {
    return JSON.parse(contents);
  } catch {
    // The parser's own message quotes the offending text, and the offending text is a credential file.
    throw new Error(`${file} is not readable JSON.`);
  }
}

/**
 * Resolves one region's account through the order a machine or CI can substitute at, without a diff:
 * `~/.heroplus/fixture-accounts.json` → the repo's own table, if it ships one → this kit's default.
 * A repo needs no table at all unless it carries a region the kit does not.
 */
export function resolveAccount(
  region,
  { repoAccounts, machineFile = machineAccountsFile() } = {}
) {
  const key = String(region ?? '').toUpperCase();
  if (key === '')
    throw new Error('resolveAccount needs a region, such as TH, HK or MY.');

  const [account, source] =
    [
      [readMachineAccounts(machineFile)?.[key], machineFile],
      [repoAccounts?.[key], "this repo's account table"],
      [DEFAULT_ACCOUNTS[key], 'the fe-test-kit default table'],
    ].find(([candidate]) => candidate !== undefined) ?? [];

  if (account === undefined)
    throw new Error(
      `No fixture account for region ${key}. The kit carries ${Object.keys(DEFAULT_ACCOUNTS).join(', ')}; ` +
        `add another in ${machineFile} or in this repo's own table.`
    );

  // Checked here rather than at the request: a half-filled override otherwise surfaces as a 422 from
  // merchant_signup naming a field, with nothing pointing back at which of the three sources it came from.
  const missing = FIELDS.filter(
    field => typeof account[field] !== 'string' || account[field] === ''
  );
  if (missing.length > 0)
    throw new Error(
      `The ${key} account from ${source} is missing ${missing.join(', ')}. ` +
        `An account needs all of: ${FIELDS.join(', ')}.`
    );

  return { region: key, source, ...account };
}
