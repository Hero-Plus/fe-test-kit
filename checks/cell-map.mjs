#!/usr/bin/env node
// checks/cell-map.mjs — asserts each pinned `(scenario, view)` cell still resolves to the body and
// id it was built from. A cell re-pointed at a different transaction keeps a verbatim-captured body
// and keeps tsc and jest clean, while every test on that scenario silently asserts against the wrong
// one. The sibling checks miss it: they walk bodies, and neither knows what binds a scenario to one.
//
// This is the one corpus check that survives its own commit. It pins against the cell manifest,
// invokes no git and reads no HEAD, so it keeps asserting after the change is committed — where
// `verbatim`, `origin-set` and `capture-provenance` compare against HEAD and have nothing left to.
//
// The corpus arrives as data from the host's `enumerateCells()`. `view` is whatever vocabulary that
// host uses, so a repo with four views pins all four through the same engine as a repo with two.
//
// Usage: hp-fixtures-cell-map [--write] [--list]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listBodies } from '../lib/cells.mjs';
import { finish, setupError } from '../lib/outcomes.mjs';
import {
  CELL_MANIFEST,
  CELL_MANIFEST_RELATIVE,
  enumerateCells,
  SCRIPTS,
} from '../config.mjs';

const CHECK = 'cell-map';

// Derived from this file's location rather than named: each package manager lays `node_modules` out
// differently, so no fixed path is right in every repo that installs this package.
const REWRITE_COMMAND = (() => {
  const self = fileURLToPath(import.meta.url);
  const fromCwd = path.relative(process.cwd(), self);
  return `node ${fromCwd.startsWith('..') ? self : fromCwd} --write`;
})();
const PIN_COMMAND = SCRIPTS?.pinCells ?? REWRITE_COMMAND;
const LIST_COMMAND = SCRIPTS?.listCells ?? `${REWRITE_COMMAND} --list`;

const sortedEntries = record =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))
  );

let live;
try {
  live = await enumerateCells();
} catch (err) {
  // Names the host export rather than the corpus: the ancestor of this message blamed the corpus for
  // what is almost always a config seam that never ran.
  setupError(
    CHECK,
    `this repo's enumerateCells() threw — ${err.message}\n` +
      "  It is the host's own corpus reader, named on HP_FIXTURES_CONFIG. The engine reads no host\n" +
      '  source, so nothing here can resolve a cell without it.'
  );
}

for (const field of [
  'cells',
  'aux',
  'scenarios',
  'views',
  'ragged',
  'duplicated',
])
  if (!Array.isArray(live?.[field]))
    setupError(CHECK, `enumerateCells() returned no \`${field}\` array.`);

// A view outside the host's own declared vocabulary means the two halves of its provider disagree,
// and `--write` below would mint a manifest from the disagreement.
const undeclared = [
  ...new Set(
    live.cells.map(cell => cell.view).filter(view => !live.views.includes(view))
  ),
];
if (undeclared.length)
  setupError(
    CHECK,
    `enumerateCells() reported cells in ${undeclared.length} view(s) it does not declare: ${undeclared.join(', ')}.`
  );

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
        { source: cell.source, id: cell.id ?? null },
      ])
    )
  ),
  aux: sortedEntries(
    Object.fromEntries(
      live.aux.map(entry => [
        entry.name,
        { source: entry.source, id: entry.id ?? null },
      ])
    )
  ),
};

console.log(
  `${CHECK}: ${observed.counts.scenarios} scenarios · ${observed.counts.cells} filled cells · ${observed.counts.aux} aux bodies`
);
console.log(`  cells by view: ${JSON.stringify(observed.counts.byView)}`);
console.log(
  `  scenarios with no list row: ${observed.ragged.length ? observed.ragged.join(', ') : 'none'}`
);

// A body the registry cannot resolve, and a body no registry entry names, are the same defect seen
// from two sides, and both are silent: one `railed(`-style wrapper around a registry value drops
// exactly one cell, leaves the rest resolving, and regenerates a manifest one body short. Failing
// here is what stops that from being a clean-looking `--write`.
const unresolved = [
  ...live.cells
    .filter(cell => !cell.source)
    .map(
      cell =>
        `${cell.scenario}.${cell.view}: the registry value resolved to no file`
    ),
  ...live.aux
    .filter(entry => !entry.source)
    .map(entry => `aux.${entry.name}: the registry value resolved to no file`),
];
const named = new Set(
  [...live.cells, ...live.aux].map(entry => entry.source).filter(Boolean)
);
const orphans = listBodies()
  .filter(body => !named.has(body.relative))
  .map(body => `${body.relative}: no cell and no aux entry names this body`);

if (unresolved.length || orphans.length)
  finish({
    check: CHECK,
    assertedCount: live.cells.length + live.aux.length,
    assertedUnit: 'registry entries resolved',
    failures: [...unresolved, ...orphans],
    remediation:
      '  Every body in an origin directory is reachable from the registry, and every registry entry\n' +
      '  resolves to one. An unresolvable value is usually a wrapper call around it — resolution is by\n' +
      '  object identity, and a call that returns a new object breaks it. A body no entry names has\n' +
      '  either been dropped from the registry or never added to it.',
  });

if (live.cells.length + live.aux.length === 0)
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: 'pinned bodies',
    vacuousReason:
      'enumerateCells() resolved no cell and no aux body, so there was nothing to pin.',
  });

if (live.duplicated.length) {
  console.log(
    `\n  note: ${live.duplicated.length} id(s) appear on more than one captured list page:`
  );
  for (const d of live.duplicated) console.log(`    ${d.scenario}  ${d.id}`);
}

// Exits 0 having asserted nothing, and stays outside the outcome vocabulary deliberately: this is a
// generator invocation, not a check run, and its product is reviewed through `--list` and the diff.
// The guards above run first, so a corpus the host cannot fully resolve can never mint a manifest.
if (process.argv.includes('--write')) {
  writeFileSync(CELL_MANIFEST, `${JSON.stringify(observed, null, 2)}\n`);
  console.log(
    `\nwrote ${CELL_MANIFEST_RELATIVE} — ${live.cells.length} cells, ${live.aux.length} aux`
  );
  console.log(`  review it:  ${LIST_COMMAND}`);
  process.exit(0);
}

if (!existsSync(CELL_MANIFEST))
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: 'pinned bodies',
    vacuousReason:
      `${CELL_MANIFEST_RELATIVE} does not exist in this repo, so nothing pins the ` +
      `${live.cells.length + live.aux.length} resolved bodies.\n` +
      `  Generate and review the manifest:  ${PIN_COMMAND}`,
  });

let pinned;
try {
  pinned = JSON.parse(readFileSync(CELL_MANIFEST, 'utf8'));
} catch (err) {
  setupError(
    CHECK,
    `${CELL_MANIFEST_RELATIVE} is not valid JSON — ${err.message}`
  );
}

const failures = [];

for (const [key, expected] of Object.entries(pinned.cells ?? {})) {
  const actual = observed.cells[key];
  if (!actual) {
    failures.push(`${key}: pinned cell is no longer filled`);
    continue;
  }
  if (actual.id !== expected.id)
    failures.push(`${key}: id ${actual.id} — pinned ${expected.id}`);
  if (actual.source !== expected.source)
    failures.push(`${key}: body ${actual.source} — pinned ${expected.source}`);
}
for (const key of Object.keys(observed.cells)) {
  if (!(key in (pinned.cells ?? {}))) failures.push(`${key}: cell is not pinned`);
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
  if (!(name in (pinned.aux ?? {}))) failures.push(`aux.${name}: is not pinned`);
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

if (JSON.stringify(observed.ragged) !== JSON.stringify(pinned.ragged ?? []))
  failures.push(
    `scenarios with no list row: ${JSON.stringify(observed.ragged)} — pinned ${JSON.stringify(pinned.ragged ?? [])}`
  );

const pinnedCells = Object.keys(pinned.cells ?? {}).length;
const pinnedAux = Object.keys(pinned.aux ?? {}).length;
console.log(`  pinned cells: ${pinnedCells}  ·  pinned aux: ${pinnedAux}`);

if (process.argv.includes('--list')) {
  console.log('\nfull cell map:');
  for (const [key, cell] of Object.entries(observed.cells))
    console.log(`  ${key} → ${cell.source} → ${cell.id}`);
  for (const [name, entry] of Object.entries(observed.aux))
    console.log(`  aux.${name} → ${entry.source} → ${entry.id}`);
}

finish({
  check: CHECK,
  assertedCount: pinnedCells + pinnedAux,
  assertedUnit: 'pinned bodies',
  failures,
  remediation:
    '  A cell moved. Either the registry was re-pointed by mistake, or the move is intended and the\n' +
    `  manifest is regenerated and reviewed in the same commit:  ${PIN_COMMAND}`,
  vacuousReason:
    `${CELL_MANIFEST_RELATIVE} pins no cell and no aux body, so no binding was checked.\n` +
    `  Generate and review the manifest:  ${PIN_COMMAND}`,
  pass: 'every pinned cell resolves to its expected body and id',
});
