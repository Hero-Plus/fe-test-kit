#!/usr/bin/env node
// checks/cell-map.mjs — asserts each pinned `(scenario, view)` cell still resolves to
// the body and purchase it was built from. A cell re-pointed at a different purchase keeps a
// verbatim-captured body and keeps tsc and jest clean, while every test on that scenario silently
// asserts against the wrong transaction. The sibling checks miss it: they walk bodies, and neither
// reads the registry that binds a scenario to one.
//
// This is the one corpus check that survives its own commit. It pins against the cell manifest,
// invokes no git and reads no HEAD, so it keeps asserting after the change is committed — where
// `verbatim` and `origin-set` go vacuous by construction.
//
// Usage: hp-fixtures-cell-map [--write] [--list]
// Exit codes: 0 pass, 1 a cell moved or a count changed, 2 setup error.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateCells, REGISTRY_RELATIVE } from '../lib/cells.mjs';
import { VACUOUS } from '../lib/exit-codes.mjs';
import { CELL_MANIFEST, CELL_MANIFEST_RELATIVE } from '../config.mjs';

// Derived from this file's location rather than named: each package manager lays `node_modules` out
// differently, so no fixed path is right in every repo that installs this package.
const REWRITE_COMMAND = (() => {
  const self = fileURLToPath(import.meta.url);
  const fromCwd = path.relative(process.cwd(), self);
  return `node ${fromCwd.startsWith('..') ? self : fromCwd} --write`;
})();

const sortedEntries = record =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))
  );

let live;
try {
  live = enumerateCells();
} catch (err) {
  console.error(`cell-map: could not read the corpus — ${err.message}`);
  process.exit(2);
}

const byView = {};
for (const cell of live.cells) byView[cell.view] = (byView[cell.view] ?? 0) + 1;

const observed = {
  counts: {
    scenarios: live.scenarios.length,
    cells: live.cells.length,
    byView: sortedEntries(byView),
    aux: live.aux.length,
  },
  ragged: [...live.ragged].sort(),
  cells: sortedEntries(
    Object.fromEntries(
      live.cells.map(cell => [
        `${cell.scenario}.${cell.view}`,
        { source: cell.source, purchase: cell.purchase },
      ])
    )
  ),
  aux: sortedEntries(
    Object.fromEntries(
      live.aux.map(entry => [
        entry.name,
        { source: entry.source, id: entry.id },
      ])
    )
  ),
};

console.log(
  `cell-map: ${observed.counts.scenarios} scenarios · ${observed.counts.cells} filled cells · ${observed.counts.aux} aux bodies`
);
console.log(`  cells by view: ${JSON.stringify(observed.counts.byView)}`);
console.log(
  `  scenarios with no list row: ${observed.ragged.length ? observed.ragged.join(', ') : 'none'}`
);

// A corpus that resolved no cell at all is a broken read, not a clean one — a registry this check
// stopped being able to parse would otherwise report a confident PASS having asserted nothing.
if (live.cells.length === 0) {
  console.error(
    `\ncell-map: resolved 0 cells from ${REGISTRY_RELATIVE}. Nothing was asserted.`
  );
  process.exit(2);
}

if (live.duplicated.length) {
  console.log(
    `\n  note: ${live.duplicated.length} purchase(s) appear on more than one captured list page:`
  );
  for (const d of live.duplicated)
    console.log(`    ${d.scenario}  ${d.purchase}`);
}

if (process.argv.includes('--write')) {
  writeFileSync(CELL_MANIFEST, `${JSON.stringify(observed, null, 2)}\n`);
  console.log(`\nwrote ${CELL_MANIFEST_RELATIVE} — ${live.cells.length} cells`);
  process.exit(0);
}

if (!existsSync(CELL_MANIFEST)) {
  console.error(
    `\ncell-map: asserted nothing — ${CELL_MANIFEST_RELATIVE} does not exist in this repo.`
  );
  console.error(
    `  ${live.cells.length} cell(s) resolved but nothing pins them, so no binding was checked.\n` +
      '  Generate and review the manifest:\n' +
      `    ${REWRITE_COMMAND}`
  );
  process.exit(VACUOUS);
}

let pinned;
try {
  pinned = JSON.parse(readFileSync(CELL_MANIFEST, 'utf8'));
} catch (err) {
  console.error(
    `cell-map: ${CELL_MANIFEST_RELATIVE} is not valid JSON — ${err.message}`
  );
  process.exit(2);
}

const failures = [];

for (const [key, expected] of Object.entries(pinned.cells ?? {})) {
  const actual = observed.cells[key];
  if (!actual) {
    failures.push(`${key}: pinned cell is no longer filled`);
    continue;
  }
  if (actual.purchase !== expected.purchase)
    failures.push(
      `${key}: purchase ${actual.purchase} — pinned ${expected.purchase}`
    );
  if (actual.source !== expected.source)
    failures.push(`${key}: body ${actual.source} — pinned ${expected.source}`);
}
for (const key of Object.keys(observed.cells)) {
  if (!(key in (pinned.cells ?? {})))
    failures.push(`${key}: cell is not pinned`);
}

for (const [name, expected] of Object.entries(pinned.aux ?? {})) {
  const actual = observed.aux[name];
  if (!actual) {
    failures.push(`aux.${name}: pinned body is gone`);
    continue;
  }
  if (actual.source !== expected.source)
    failures.push(
      `aux.${name}: body ${actual.source} — pinned ${expected.source}`
    );
  if (actual.id !== expected.id)
    failures.push(`aux.${name}: id ${actual.id} — pinned ${expected.id}`);
}
for (const name of Object.keys(observed.aux)) {
  if (!(name in (pinned.aux ?? {})))
    failures.push(`aux.${name}: is not pinned`);
}

for (const [name, value] of Object.entries(observed.counts)) {
  const expected = pinned.counts?.[name];
  const same =
    typeof value === 'object'
      ? JSON.stringify(value) === JSON.stringify(expected)
      : value === expected;
  if (!same)
    failures.push(
      `count ${name}: ${JSON.stringify(value)} — pinned ${JSON.stringify(expected)}`
    );
}

// The ragged set is the visible edge of this check re-deriving `corpus.ts`'s row lookup rather than
// importing it. If that rule changes on one side only, the set moves and says so here.
if (JSON.stringify(observed.ragged) !== JSON.stringify(pinned.ragged ?? []))
  failures.push(
    `scenarios with no list row: ${JSON.stringify(observed.ragged)} — pinned ${JSON.stringify(pinned.ragged ?? [])}`
  );

console.log(
  `  pinned cells asserted: ${Object.keys(pinned.cells ?? {}).length}  ·  pinned aux: ${Object.keys(pinned.aux ?? {}).length}`
);

if (process.argv.includes('--list')) {
  console.log('\nfull cell map:');
  for (const [key, cell] of Object.entries(observed.cells))
    console.log(`  ${key} → ${cell.source} → ${cell.purchase}`);
}

if (failures.length) {
  console.error(
    `\nFAIL — ${failures.length} problem(s) vs ${CELL_MANIFEST_RELATIVE}:`
  );
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\n  A cell moved. Either the registry was re-pointed by mistake, or the move is intended and\n' +
      '  the manifest is regenerated and reviewed in the same commit:\n' +
      `    ${REWRITE_COMMAND}`
  );
  process.exit(1);
}

console.log(
  '\nPASS — every pinned cell resolves to its expected body and purchase'
);
