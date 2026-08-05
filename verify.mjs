#!/usr/bin/env node
// Runs the checks this repo declares, plus the engine's own unit suites.
//
// The check set is the host's, in its `CHECKS` export — not a list in this file and not a directory
// read. Auto-discovery would leave this file byte-identical across the FE repos while making
// check-set divergence between them invisible; a list in this file could not express that one repo
// runs four checks and another six. A `kit:` entry resolves inside this package, so a missing file
// can only be a packaging failure; a `host:` entry resolves against REPO_ROOT, and a missing one is
// a config error, because the host named it.
//
// A `host:` check predates this package's outcome vocabulary and never calls `finish()`, so its bare
// exit code is read literally — 0 asserted, 1 failed, 2 setup error, 3 only if it happens to use it —
// and `onVacuous` is inert for one. `lib/host-config.mjs` refuses the knob on a `host:` entry rather
// than accepting a policy that would silently do nothing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_VAR, loadHostConfig } from './lib/host-config.mjs';
import { FAILED, SETUP_ERROR, VACUOUS } from './lib/outcomes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A run reached from inside a run would spawn every check again, including the suites that spawn
// this file, and the symptom is a hung machine rather than a failed test. Refused, so the mistake
// names itself.
const NESTED = 'HP_FIXTURES_VERIFY_RUNNING';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Appended to every host's list and not droppable: they assert nothing about the corpus, so a repo
// has no grounds to decline them, and this is the only executor a pull request reaches.
const UNIT_SUITES = [
  { name: 'config-unit', kit: 'config-test.mjs', required: true },
  { name: 'detector-unit', kit: 'lib/luhn-test.mjs', required: true },
  { name: 'outcomes-unit', kit: 'outcomes-test.mjs', required: true },
  { name: 'parser-unit', kit: 'lib/registry-parser-test.mjs', required: true },
  { name: 'shapes-unit', kit: 'shapes-test.mjs', required: true },
];

if (process.env[NESTED]) {
  console.error(
    `\n${RED}fixtures:verify is already running${RESET} in a parent process. A check that invokes the\n` +
      'runner recurses without end; run the check directly instead.'
  );
  process.exit(SETUP_ERROR);
}

// Loaded here rather than through `config.mjs`, which resolves at module scope and arms a handler
// this file does not want: the runner needs plain try/catch, and it must not require the per-check
// names its host has not enabled.
let config;
try {
  config = await loadHostConfig();
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(SETUP_ERROR);
}

const RUN_COMMAND = config.SCRIPTS?.verify ?? 'hp-fixtures-verify';
const CONFIG_SOURCE = process.env[CONFIG_VAR];

const reserved = UNIT_SUITES.map(suite => suite.name);
const clashing = config.CHECKS.filter(entry => reserved.includes(entry.name));
if (clashing.length > 0) {
  console.error(
    `\n${RED}CHECKS uses ${clashing.length} name(s) this package reserves for its unit suites:${RESET} ` +
      `${clashing.map(entry => entry.name).join(', ')}.\n` +
      `Rename them in ${CONFIG_SOURCE}, so each line of the summary below names one check.`
  );
  process.exit(SETUP_ERROR);
}

const results = [];
for (const check of [...config.CHECKS, ...UNIT_SUITES]) {
  const file = check.kit
    ? path.join(__dirname, check.kit)
    : path.join(config.REPO_ROOT, check.host);
  // Decided before spawning, never by reading a spawn failure: a check with a genuinely broken
  // import would otherwise present as one this repo does not carry, and turn itself off silently.
  if (!existsSync(file)) {
    console.log(
      `${DIM}── fixtures:verify — ${check.name} — no such file ──${RESET}\n`
    );
    results.push({ ...check, file, absent: true });
    continue;
  }
  console.log(`${DIM}── fixtures:verify — ${check.name} ──${RESET}`);
  const run = spawnSync(process.execPath, [file], {
    stdio: 'inherit',
    env: { ...process.env, [NESTED]: '1' },
  });
  results.push({ ...check, file, code: run.status ?? SETUP_ERROR });
  console.log('');
}

const vacuousFailing = [];
for (const r of results) {
  if (r.absent) {
    console.log(`  ${DIM}SKIP${RESET}  ${r.name} ${DIM}(no such file)${RESET}`);
    continue;
  }
  // VACUOUS gets its own tag rather than reusing SKIP, which above means the check *file* was absent
  // — a different problem from a check that ran.
  if (r.code === VACUOUS) {
    const tolerated = r.kit && r.onVacuous === 'warn';
    if (!tolerated) vacuousFailing.push(r);
    console.log(
      `  ${YELLOW}VACUOUS${RESET}  ${r.name} ${DIM}(ran, asserted nothing${tolerated ? ' — tolerated by onVacuous: warn' : ''})${RESET}`
    );
    continue;
  }
  const tag = r.code === 0 ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${tag}  ${r.name}${r.code === 0 ? '' : ` (exit ${r.code})`}`);
}

const missingKit = results.filter(r => r.absent && r.kit && r.required);
if (missingKit.length > 0) {
  console.error(
    `\n${RED}Required check(s) this package did not ship:${RESET} ${missingKit.map(r => r.kit).join(', ')}.\n` +
      'Every kit entry resolves inside the installed package, so this is a packaging failure rather\n' +
      'than a repo declining a check. Reinstall the dependency.'
  );
  process.exit(SETUP_ERROR);
}

const missingHost = results.filter(r => r.absent && r.host);
if (missingHost.length > 0) {
  console.error(
    `\n${RED}Host check file(s) not found:${RESET} ${missingHost.map(r => r.host).join(', ')}.\n` +
      `This repo named them in CHECKS, so their absence is a config error rather than a decline.\n` +
      `Restore each file, or drop its entry from CHECKS in ${CONFIG_SOURCE} so the removal is a\n` +
      'decision with a diff.'
  );
  process.exit(SETUP_ERROR);
}

const ran = results.filter(r => !r.absent);
// Counted over the host's own checks, not `ran`: the unit suites are appended to every list, so a
// total including them is never 0 and this guard could never fire. Reachable by an emptied `CHECKS`
// or by a non-required `kit:` entry whose file is absent, which SKIPs rather than erroring above.
const ranCorpus = ran.filter(r => !reserved.includes(r.name));
if (ranCorpus.length === 0) {
  console.error(
    `\n${RED}No corpus check ran.${RESET} ` +
      (config.CHECKS.length === 0
        ? `CHECKS is empty in ${CONFIG_SOURCE}.`
        : `Every check ${CONFIG_SOURCE} declares was absent.`) +
      '\nThe unit suites above assert nothing about this corpus, so this run would otherwise report\n' +
      'success while asserting nothing about it.'
  );
  process.exit(SETUP_ERROR);
}

// Deliberately not fail-fast: when a fixture change goes wrong, whether the other checks also broke
// is the question you need answered on the first run.
if (ran.some(r => r.code === SETUP_ERROR)) process.exit(SETUP_ERROR);
if (ran.some(r => r.code !== 0 && r.code !== VACUOUS)) process.exit(FAILED);

if (vacuousFailing.length > 0) {
  console.error(
    `\n${RED}${vacuousFailing.length} check(s) asserted nothing:${RESET} ${vacuousFailing.map(r => r.name).join(', ')}.\n` +
      `A run is not green because nothing objected. Wire the config each one names; or, where the\n` +
      `emptiness is the normal state of this repo's CI checkout, set onVacuous: 'warn' on its entry in\n` +
      `${CONFIG_SOURCE} — which keeps the VACUOUS tag above and stops it reddening ${RUN_COMMAND};\n` +
      'or drop the entry entirely, so the removal is a decision with a diff.'
  );
  process.exit(VACUOUS);
}
process.exit(0);
