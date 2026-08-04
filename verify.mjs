#!/usr/bin/env node
// Runs every corpus-integrity check and the engine's own unit suites. Exit codes: 0 all passed, 1 at
// least one failed, 2 a check hit a setup error.
//
// The checks split on durability, and the split is easy to get backwards. `no-pan`, `cell-map` and
// `rule-coverage` pin against a committed expectation, so they keep asserting after the change is
// committed; `verbatim` and `origin-set` compare against HEAD, so those two alone are pre-commit
// guards that pass vacuously on a clean tree.
//
// The list below is explicit rather than a directory read: auto-discovery would leave this file
// byte-identical across the FE repos while making check-set divergence between them invisible, and
// would turn deleting a check into a behaviour change with no diff.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// `required` marks a file whose absence can only be a packaging failure: the loop below joins
// `__dirname`, so every entry resolves inside this package and a missing one means the package did
// not ship it, never that an adopting repo declined the check.
//
// The three unit suites assert nothing about the corpus, so the durability split above does not
// describe them. They run from this list because it is the only executor a pull request reaches, and
// a node:test file run directly meets the same protocol as a check — its own log on stdout, non-zero
// exit on a failed assertion.
const CHECKS = [
  { name: 'no-pan', file: 'checks/no-pan.mjs', required: true },
  { name: 'verbatim', file: 'checks/verbatim.mjs' },
  { name: 'origin-set', file: 'checks/origin-set.mjs' },
  { name: 'cell-map', file: 'checks/cell-map.mjs' },
  { name: 'rule-coverage', file: 'checks/rule-coverage.mjs' },
  { name: 'detector-unit', file: 'lib/luhn-test.mjs', required: true },
  { name: 'shapes-unit', file: 'shapes-test.mjs', required: true },
  { name: 'config-unit', file: 'config-test.mjs', required: true },
];

const results = [];
for (const check of CHECKS) {
  const file = path.join(__dirname, check.file);
  // Decided before spawning, never by reading a spawn failure: a check with a genuinely broken
  // import would otherwise present as one this repo does not carry, and turn itself off silently.
  if (!existsSync(file)) {
    console.log(
      `${DIM}── fixtures:verify — ${check.name} — not present in this repo ──${RESET}\n`
    );
    results.push({ ...check, absent: true });
    continue;
  }
  console.log(`${DIM}── fixtures:verify — ${check.name} ──${RESET}`);
  const run = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  results.push({ ...check, code: run.status ?? 2 });
  console.log('');
}

for (const r of results) {
  if (r.absent) {
    console.log(
      `  ${DIM}SKIP${RESET}  ${r.name} ${DIM}(no such check file)${RESET}`
    );
    continue;
  }
  const tag = r.code === 0 ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${tag}  ${r.name}${r.code === 0 ? '' : ` (exit ${r.code})`}`);
}

const missing = results.filter(r => r.absent && r.required);
if (missing.length > 0) {
  console.error(
    `\n${RED}Required check(s) not present:${RESET} ${missing.map(r => r.file).join(', ')}.\n` +
      'Restore the file, or drop it from CHECKS in this file so the removal is a decision with a\n' +
      'diff rather than a gate that quietly stopped asserting.'
  );
  process.exit(2);
}

const ran = results.filter(r => !r.absent);
if (ran.length === 0) {
  console.error(
    `\n${RED}No check ran.${RESET} An empty verify reports success while asserting nothing.`
  );
  process.exit(2);
}

// Deliberately not fail-fast: when a fixture change goes wrong, whether the other checks also broke
// is the question you need answered on the first run.
if (ran.some(r => r.code === 2)) process.exit(2);
process.exit(ran.some(r => r.code !== 0) ? 1 : 0);
