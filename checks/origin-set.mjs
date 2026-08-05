#!/usr/bin/env node
// checks/origin-set.mjs — asserts no body silently changed origin. A body's directory is its whole
// origin classification, so a captured body moved into `authored/` compiles clean, passes every test,
// and turns a pinned wire record into a hand-written one with no other signal.
//
// Two halves on opposite sides of durability, and reading them as one is how a CI job ends up trusted
// for something it never checked. The bucket comparison is working tree vs HEAD, so it asserts only
// while HEAD carries bodies to compare against — that is what the count below counts. The corpus-root
// allowlist reads only the filesystem, keeps asserting forever, and is deliberately not counted: a
// count the allowlist props up can never reach zero, and a vacuity signal that can never fire is not
// one.
//
// Usage: no options; runs from hp-fixtures-verify
import { existsSync, readdirSync } from 'node:fs';

import { headPaths, isBody, listBodies, originOf } from '../lib/cells.mjs';
import { finish, setupError } from '../lib/outcomes.mjs';
import {
  CORPUS_ROOT_FILES,
  CORPUS_ROOT_SUFFIXES,
  FIXTURES_DIR,
  FIXTURES_RELATIVE,
  ORIGIN_RELATIVE,
} from '../config.mjs';

const CHECK = 'origin-set';

const ROOT_DIRS = ORIGIN_RELATIVE.map(dir => dir.slice(dir.lastIndexOf('/') + 1));

// Asserted rather than only documented: a corpus-root path is either a body that belongs in an
// origin directory or infrastructure that belongs on the allowlist, and letting one through unnamed
// is how a body escapes classification.
const rootAllowed = name =>
  CORPUS_ROOT_FILES.includes(name) ||
  CORPUS_ROOT_SUFFIXES.some(s => name.endsWith(s));

// An origin directory outside the corpus root would make the root walk below blind to it, so the
// bucket half would report on a tree the allowlist half never sees.
const strayOrigins = ORIGIN_RELATIVE.filter(
  dir => !dir.startsWith(`${FIXTURES_RELATIVE}/`)
);
if (strayOrigins.length)
  setupError(
    CHECK,
    `ORIGIN_RELATIVE holds ${strayOrigins.length} directory(ies) outside ${FIXTURES_RELATIVE}: ${strayOrigins.join(', ')}.`
  );

const ASSERTED_UNIT = 'body origins compared against HEAD';
const REMEDIATION =
  '  A captured body is a wire record and an authored one is an argument, so a bucket change changes\n' +
  '  what the body proves. Move it back, or make the reclassification the commit. A path at the\n' +
  "  corpus root belongs in an origin directory or on this check's root allowlist, so that adding it\n" +
  '  is a decision rather than an omission.';

// Vacuous rather than a setup error: `no-pan` reads the same absent corpus as vacuous, and exit 2 is
// the one outcome `onVacuous` cannot soften — so erroring here would deny a repo adopting this check
// before its corpus lands any way to say that the emptiness is its normal state.
if (!existsSync(FIXTURES_DIR))
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: ASSERTED_UNIT,
    vacuousReason:
      `${FIXTURES_RELATIVE} does not exist in this repo, so nothing could be classified.\n` +
      '  Normal in a repo that adopted this check before it carries a corpus; otherwise\n' +
      '  HP_FIXTURES_CONFIG points at a tree that does not hold one.',
  });

// Collected ahead of the vacuity branch below and passed into every finish(), which weighs failures
// before the count: this half reads only the filesystem, so it still holds when there is nothing to
// compare, and an `onVacuous: 'warn'` host would otherwise stop seeing a stray root file the moment
// its corpus emptied.
const failures = [];
for (const entry of readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    if (!ROOT_DIRS.includes(entry.name))
      failures.push(`${entry.name}/ — unlisted directory at the corpus root`);
  } else if (!rootAllowed(entry.name)) {
    failures.push(`${entry.name} — unlisted file at the corpus root`);
  }
}

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
  setupError(
    CHECK,
    `could not read the HEAD corpus — ${String(err.stderr ?? err).slice(0, 300)}`
  );
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
  `${CHECK}: ${live.map.size} classified bodies in ${FIXTURES_RELATIVE} · HEAD: ${head.map.size}`
);
console.log(`  by origin: ${JSON.stringify(byOrigin)}`);

// An empty origin tree would otherwise report a confident PASS having classified nothing.
if (live.map.size === 0)
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: ASSERTED_UNIT,
    failures,
    remediation: REMEDIATION,
    vacuousReason:
      `No classified body was found under ${ORIGIN_RELATIVE.join(', ')}, so no origin could be\n` +
      '  compared. Normal mid-restructure, or in a repo that adopted this check before its corpus\n' +
      '  landed.',
  });

// An ambiguity in the keying is a setup error rather than a finding: two same-named bodies in
// different buckets make a move between those buckets invisible.
const collisions = [...live.collisions, ...head.collisions];
if (collisions.length)
  setupError(
    CHECK,
    `${collisions.length} body basename(s) are not unique, so origin cannot be tracked:\n` +
      collisions.map(c => `  ${c}`).join('\n')
  );

const entered = [];
const left = [];
let compared = 0;

for (const [basename, body] of live.map) {
  const before = head.map.get(basename);
  if (!before) {
    entered.push(body);
    continue;
  }
  compared += 1;
  if (before.origin !== body.origin)
    failures.push(
      `${basename}: ${before.origin} → ${body.origin}  (${before.relative} → ${body.relative})`
    );
}
for (const [basename, body] of head.map) {
  if (!live.map.has(basename)) left.push(body);
}

console.log(`  origins compared against HEAD: ${compared}`);
console.log(`  bodies newly classified: ${entered.length}`);
for (const b of entered) console.log(`    + ${b.origin}  ${b.relative}`);
console.log(`  bodies no longer classified: ${left.length}`);
for (const b of left) console.log(`    - ${b.origin}  ${b.relative}`);
console.log(
  `  corpus root allowlist: ${CORPUS_ROOT_FILES.length} names, ${CORPUS_ROOT_SUFFIXES.join(' ')}, ${ROOT_DIRS.map(d => `${d}/`).join(' ')}`
);

finish({
  check: CHECK,
  assertedCount: compared,
  assertedUnit: ASSERTED_UNIT,
  failures,
  remediation: REMEDIATION,
  vacuousReason:
    'No body in the working tree is also at HEAD, so no origin could be compared. Normal while a\n' +
    '  corpus is being built or restructured and not yet committed.',
  pass: 'no body changed origin bucket, and the corpus root is fully accounted for',
});
