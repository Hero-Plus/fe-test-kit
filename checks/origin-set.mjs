#!/usr/bin/env node
// checks/origin-set.mjs — asserts no body silently changed origin. A body's directory
// is its whole origin classification, so a captured body moved into `authored/` compiles clean,
// passes every test, and turns a pinned wire record into a hand-written one with no other signal.
//
// Two halves on opposite sides of durability, and reading them as one is how a CI job ends up
// trusted for something it never checked. The bucket comparison is working tree vs HEAD, so once
// committed it has nothing left to compare — while still exiting 0 — and `cell-map.mjs` is the durable
// guard for it. The corpus-root allowlist reads only the filesystem and keeps asserting forever.
//
// Usage: no options; runs from hp-fixtures-verify
// Exit codes: 0 pass, 1 a body changed bucket or an unclassified path appeared, 2 setup error.
import { readdirSync } from 'node:fs';

import { headPaths, isBody, listBodies, originOf } from '../lib/cells.mjs';
import {
  CORPUS_ROOT_FILES,
  CORPUS_ROOT_SUFFIXES,
  FIXTURES_DIR,
  FIXTURES_RELATIVE,
  ORIGIN_RELATIVE,
} from '../config.mjs';

const ROOT_DIRS = ORIGIN_RELATIVE.map(dir =>
  dir.slice(dir.lastIndexOf('/') + 1)
);

// Asserted rather than only documented: a corpus-root path is either a body that belongs in an
// origin directory or infrastructure that belongs on the allowlist, and letting one through unnamed
// is how a body escapes classification.
const rootAllowed = name =>
  CORPUS_ROOT_FILES.includes(name) ||
  CORPUS_ROOT_SUFFIXES.some(s => name.endsWith(s));

// Keyed by basename, not path: the path is the thing under test, so a moved body must still look
// like the same body on both sides — keyed by path, a bucket change reads as one body vanishing and
// an unrelated one appearing.
function keyByBasename(bodies, side) {
  const map = new Map();
  const collisions = [];
  for (const body of bodies) {
    const seen = map.get(body.basename);
    if (seen) collisions.push(`${side}: ${seen.relative} and ${body.relative}`);
    else map.set(body.basename, body);
  }
  return { map, collisions };
}

const live = keyByBasename(listBodies(), 'working tree');

let headListing;
try {
  headListing = headPaths();
} catch (err) {
  console.error(
    'origin-set: could not read the HEAD corpus —',
    String(err.stderr ?? err).slice(0, 300)
  );
  process.exit(2);
}

const head = keyByBasename(
  headListing.filter(isBody).map(relative => ({
    relative,
    basename: relative.slice(relative.lastIndexOf('/') + 1),
    origin: originOf(relative),
  })),
  'HEAD'
);

const byOrigin = {};
for (const body of live.map.values())
  byOrigin[body.origin] = (byOrigin[body.origin] ?? 0) + 1;

console.log(
  `origin-set: ${live.map.size} classified bodies in ${FIXTURES_RELATIVE} · HEAD: ${head.map.size}`
);
console.log(`  by origin: ${JSON.stringify(byOrigin)}`);

// Mid-restructure or mis-pointed, an empty origin tree would otherwise report a confident PASS
// having classified nothing.
if (live.map.size === 0) {
  console.error(
    `\norigin-set: no classified body found under ${ORIGIN_RELATIVE.join(', ')}.`
  );
  process.exit(2);
}

// An ambiguity in the keying is a setup error rather than a finding: two same-named bodies in
// different buckets make a move between those buckets invisible.
const collisions = [...live.collisions, ...head.collisions];
if (collisions.length) {
  console.error(
    `\norigin-set: ${collisions.length} body basename(s) are not unique, so origin cannot be tracked:`
  );
  for (const c of collisions) console.error(`  ${c}`);
  process.exit(2);
}

const failures = [];
const entered = [];
const left = [];

for (const [basename, body] of live.map) {
  const before = head.map.get(basename);
  if (!before) entered.push(body);
  else if (before.origin !== body.origin)
    failures.push(
      `${basename}: ${before.origin} → ${body.origin}  (${before.relative} → ${body.relative})`
    );
}
for (const [basename, body] of head.map) {
  if (!live.map.has(basename)) left.push(body);
}

// Path sets, not the three tallies above: those also all read zero for a body moved within one
// bucket, which is a real difference this check correctly ignores rather than a failure to compare.
const relativesOf = side =>
  new Set([...side.map.values()].map(b => b.relative));
const liveRelatives = relativesOf(live);
const headRelatives = relativesOf(head);
const comparedNothing =
  liveRelatives.size === headRelatives.size &&
  [...liveRelatives].every(relative => headRelatives.has(relative));

const rootStrays = [];
for (const entry of readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    if (!ROOT_DIRS.includes(entry.name))
      rootStrays.push(`${entry.name}/ — unlisted directory at the corpus root`);
  } else if (!rootAllowed(entry.name)) {
    rootStrays.push(`${entry.name} — unlisted file at the corpus root`);
  }
}

console.log(`  bodies newly classified: ${entered.length}`);
for (const b of entered) console.log(`    + ${b.origin}  ${b.relative}`);
console.log(`  bodies no longer classified: ${left.length}`);
for (const b of left) console.log(`    - ${b.origin}  ${b.relative}`);
console.log(
  `  corpus root allowlist: ${CORPUS_ROOT_FILES.length} names, ${CORPUS_ROOT_SUFFIXES.join(' ')}, ${ROOT_DIRS.map(d => `${d}/`).join(' ')}`
);

if (comparedNothing) {
  console.log(
    '\n  ASSERTED NOTHING (bucket comparison) — the origin tree is HEAD’s path for path, so no\n' +
      '  body could have entered, left or changed bucket. A fresh checkout has no other state\n' +
      '  available, which makes this half a pre-commit guard; after the commit a bucket change is\n' +
      '  cell-map.mjs’s to catch, through the source path it pins for every cell.\n' +
      '  Still asserted, and neither reads git: the corpus-root allowlist, and that the origin tree\n' +
      '  is non-empty.'
  );
}

if (rootStrays.length) {
  console.error(
    `\nFAIL — ${rootStrays.length} corpus-root path(s) outside the origin tree and unlisted:`
  );
  for (const s of rootStrays) console.error(`  ${s}`);
  console.error(
    '\n  A wire body belongs in captured/, authored/ or derived/. Anything else belongs on this\n' +
      "  check's root allowlist, so that adding it is a decision rather than an omission."
  );
}

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} body(ies) changed origin bucket:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\n  A captured body is a wire record and an authored one is an argument, so a bucket change\n' +
      '  changes what the body proves. Move it back, or make the reclassification the commit.'
  );
}

if (failures.length || rootStrays.length) process.exit(1);
console.log(
  comparedNothing
    ? '\nPASS — the corpus root is fully accounted for (bucket comparison: nothing to compare)'
    : '\nPASS — no body changed origin bucket, and the corpus root is fully accounted for'
);
