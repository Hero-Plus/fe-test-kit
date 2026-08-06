// Split from `config.mjs` for testability, not layering: config.mjs resolves at module scope, so a
// test importing it gets one attempt per process and cannot reach the failure branches.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_VAR = 'HP_FIXTURES_CONFIG';

export const CORE_CONFIG_NAMES = Object.freeze([
  'absolute',
  'CHECKS',
  'FIXTURES_DIR',
  'FIXTURES_RELATIVE',
  'REPO_ROOT',
  'TOOLS_RELATIVE',
]);

// Keyed by the kit check *file*, never by the host's `name` for it: a host may call a check
// anything, while what a check reads is a fact about the file it runs.
//
// Requiring only what the enabled checks read is what lets a two-check repo adopt this package
// without inventing values for the other four. A frozen all-or-nothing list made every adopter
// declare a rule spec and a cell manifest it had no intention of carrying.
export const CHECK_CONFIG_NAMES = Object.freeze({
  'no-pan': Object.freeze(['PAN_ALLOWLIST', 'PAN_ALLOWLIST_RELATIVE']),
  'origin-set': Object.freeze([
    'CORPUS_ROOT_FILES',
    'CORPUS_ROOT_SUFFIXES',
    'ORIGIN_RELATIVE',
  ]),
  verbatim: Object.freeze(['CAPTURED_ORIGIN', 'ORIGIN_RELATIVE', 'readBody']),
  // ORIGIN_RELATIVE is not this check's corpus reader but its orphan detector: a body no cell and no
  // aux entry names is a body that dropped out of the registry, and only the directory walk sees it.
  'cell-map': Object.freeze([
    'CELL_MANIFEST',
    'CELL_MANIFEST_RELATIVE',
    'enumerateCells',
    'ORIGIN_RELATIVE',
  ]),
  'capture-provenance': Object.freeze([
    'CAPTURED_ORIGIN',
    'listCaptures',
    'ORIGIN_RELATIVE',
    'readBody',
  ]),
  'rule-coverage': Object.freeze([
    'RULE_EXEMPTIONS_RELATIVE',
    'TRANSACTION_TABLES',
    'TRANSACTION_TABLES_RELATIVE',
  ]),
});

// Read by no check, so never required. Absent, `SCRIPTS` leaves remediation messages falling back to a
// `node <path>` form that is right in every repo and idiomatic in none; `WIRE_CONVENTIONS` is read only
// by the host's own `makeShapes` call, and is listed so a host carrying it is not carrying a name the
// contract does not know about.
export const OPTIONAL_CONFIG_NAMES = Object.freeze([
  'SCRIPTS',
  'WIRE_CONVENTIONS',
]);

export const CONFIG_NAMES = Object.freeze(
  [
    ...new Set([
      ...CORE_CONFIG_NAMES,
      ...Object.values(CHECK_CONFIG_NAMES).flat(),
      ...OPTIONAL_CONFIG_NAMES,
    ]),
  ].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
);

const isCallable = value => typeof value === 'function';
const isStringArray = value =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string');
const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Presence alone accepts a wrong-typed export and defers the failure to an uncaught TypeError with a
// stack, mid-check, naming neither the config nor the name that was wrong.
const SHAPES = Object.freeze({
  absolute: ['a function: relative => absolute path', isCallable],
  CHECKS: ['an array of check entries', Array.isArray],
  CORPUS_ROOT_FILES: ['an array of filenames', isStringArray],
  CORPUS_ROOT_SUFFIXES: ['an array of filename suffixes', isStringArray],
  ORIGIN_RELATIVE: ['an array of repo-relative directories', isStringArray],
  enumerateCells: ['a function returning the corpus as data', isCallable],
  readBody: ['a function: absolute path => the body as a value', isCallable],
  listCaptures: ['a function returning [{ label, body }]', isCallable],
  SCRIPTS: ['an object of this repo’s script names', isPlainObject],
  WIRE_CONVENTIONS: [
    'an object of this repo’s HTTP wire conventions',
    isPlainObject,
  ],
});

const ON_VACUOUS = Object.freeze(['fail', 'warn']);

export class HostConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostConfigError';
  }
}

export function validateChecks(checks) {
  const problems = [];
  const named = new Set();

  checks.forEach((entry, index) => {
    const at = `CHECKS[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${at}: not an object`);
      return;
    }

    if (typeof entry.name !== 'string' || entry.name === '')
      problems.push(`${at}: \`name\` must be a non-empty string`);
    else if (named.has(entry.name))
      problems.push(`${at}: \`name\` '${entry.name}' is already used`);
    else named.add(entry.name);

    const kit = typeof entry.kit === 'string' && entry.kit !== '';
    const host = typeof entry.host === 'string' && entry.host !== '';
    if (kit === host)
      problems.push(
        `${at}: needs exactly one of \`kit\` (a path inside this package) or \`host\` (one relative to REPO_ROOT)`
      );

    if (entry.required !== undefined) {
      if (typeof entry.required !== 'boolean')
        problems.push(`${at}: \`required\` must be true or false`);
      // Consulted only where a `kit:` file is absent, which for a `host:` entry is already an
      // unconditional config error — so the flag on one is a decision that changes nothing.
      else if (host)
        problems.push(
          `${at}: \`required\` has no effect on a \`host:\` check — a host file the repo named and does not carry already fails the run`
        );
    }

    if (entry.onVacuous !== undefined) {
      if (!ON_VACUOUS.includes(entry.onVacuous))
        problems.push(
          `${at}: \`onVacuous\` is ${JSON.stringify(entry.onVacuous)} — use ${ON_VACUOUS.join(' or ')}`
        );
      // Refused rather than ignored: a host check predates this vocabulary and never reports
      // `vacuous`, so a policy declared on one reads as a decision that is in fact inert.
      else if (host)
        problems.push(
          `${at}: \`onVacuous\` has no effect on a \`host:\` check — its bare exit code is read literally`
        );
    }
  });

  return problems;
}

/** The config names the core plus this host's enabled kit checks actually read. */
export function requiredNamesFor(checks) {
  const names = new Set(CORE_CONFIG_NAMES);
  for (const entry of checks) {
    if (typeof entry?.kit !== 'string') continue;
    for (const name of CHECK_CONFIG_NAMES[path.basename(entry.kit, '.mjs')] ??
      [])
      names.add(name);
  }
  return [...names].sort();
}

const missingFrom = (host, names) =>
  // Compared against `undefined` rather than tested with `in`, because a dynamic import degrades a
  // name the host never exported into `undefined` instead of raising the load error a static import
  // would have. A check handed `undefined` for a corpus path takes its skip branch and exits 0,
  // which `verify.mjs` tallies as a pass.
  names.filter(name => host[name] === undefined);

export async function loadHostConfig() {
  const spec = process.env[CONFIG_VAR];
  if (!spec)
    throw new HostConfigError(
      `${CONFIG_VAR} is not set. Point it at this repo's fixture-path module — the ES module ` +
        `exporting the ${CORE_CONFIG_NAMES.length} core names plus whatever the checks in its ` +
        '`CHECKS` read. Setting it once on the verify entry point reaches every check, which ' +
        'inherits the environment.'
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

  const missingCore = missingFrom(host, [...CORE_CONFIG_NAMES]);
  if (missingCore.length > 0)
    throw new HostConfigError(
      `${CONFIG_VAR} resolved ${resolved}, but it exports no value for ${missingCore.length} of ` +
        `the ${CORE_CONFIG_NAMES.length} core names: ${missingCore.join(', ')}.`
    );

  if (!Array.isArray(host.CHECKS))
    throw new HostConfigError(
      `${CONFIG_VAR} resolved ${resolved}, whose \`CHECKS\` is not an array. It is the list of ` +
        'checks this repo runs; nothing else can be validated until it is readable.'
    );

  const malformed = validateChecks(host.CHECKS);
  if (malformed.length > 0)
    throw new HostConfigError(
      `${CONFIG_VAR} resolved ${resolved}, whose \`CHECKS\` has ${malformed.length} malformed ` +
        `entry(ies):\n  ${malformed.join('\n  ')}`
    );

  const required = requiredNamesFor(host.CHECKS);
  const missing = missingFrom(host, required);
  if (missing.length > 0)
    throw new HostConfigError(
      `${CONFIG_VAR} resolved ${resolved}, but it exports no value for ${missing.length} name(s) ` +
        `the checks in its \`CHECKS\` read: ${missing.join(', ')}.`
    );

  const wrongShape = Object.entries(SHAPES)
    .filter(([name]) => host[name] !== undefined)
    .filter(([name, [, holds]]) => !holds(host[name]))
    .map(([name, [shape]]) => `${name} must be ${shape}`);
  if (wrongShape.length > 0)
    throw new HostConfigError(
      `${CONFIG_VAR} resolved ${resolved}, but ${wrongShape.length} export(s) have the wrong ` +
        `shape:\n  ${wrongShape.join('\n  ')}`
    );

  return host;
}
