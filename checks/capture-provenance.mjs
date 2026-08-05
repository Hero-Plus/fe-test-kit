#!/usr/bin/env node
// checks/capture-provenance.mjs — asserts every body newly appearing in the captured bucket deep-
// equals a raw capture still on disk. `origin-set` catches a body *moving* into that bucket and can
// never catch one *born* there, which is the whole of "captured, never authored".
//
// Its only honest assert window is a fresh promotion whose capture has not been cleared, before the
// commit. After the commit HEAD holds the body, so nothing is new and this reports `vacuous` — that
// is the correct reading of a corpus at rest, not a defect, and not a reason to weaken the check.
//
// The captures arrive from the host's `listCaptures()` as `[{ label, body }]`. Their on-disk shape
// is a repo's own: a capture record with metadata around the body in one repo, a bare envelope in
// another, and none at all in a repo whose corpus predates its emitter.
import { AssertionError, deepStrictEqual } from 'node:assert';

import { headPaths, isBody, listBodies, originOf } from '../lib/cells.mjs';
import { finish, setupError } from '../lib/outcomes.mjs';
import {
  absolute,
  CAPTURED_ORIGIN,
  listCaptures,
  readBody,
} from '../config.mjs';

const CHECK = 'capture-provenance';

const deepEq = (a, b) => {
  try {
    deepStrictEqual(a, b);
    return true;
  } catch (err) {
    if (err instanceof AssertionError) return false;
    throw err;
  }
};

const live = listBodies().filter(body => body.origin === CAPTURED_ORIGIN);

// Guarded here rather than left to `verbatim`'s identical guard, which a host may not have enabled:
// two live bodies sharing a basename let a hand-written one borrow a committed one's name and never
// be adjudicated, since HEAD membership is keyed by basename below.
const collisions = live.filter(
  (body, index) => live.findIndex(other => other.basename === body.basename) !== index
);
if (collisions.length)
  setupError(
    CHECK,
    `${collisions.length} captured body basename(s) are not unique, so a promotion cannot be told from a move:\n` +
      collisions.map(body => `  ${body.relative}`).join('\n')
  );

let headListing;
try {
  headListing = headPaths();
} catch (err) {
  setupError(
    CHECK,
    `could not read the HEAD corpus — ${String(err.stderr ?? err).slice(0, 300)}`
  );
}

const atHead = new Set(
  headListing
    .filter(
      relative => isBody(relative) && originOf(relative) === CAPTURED_ORIGIN
    )
    .map(relative => relative.slice(relative.lastIndexOf('/') + 1))
);
const promoted = live.filter(body => !atHead.has(body.basename));

let captures;
try {
  captures = await listCaptures();
} catch (err) {
  setupError(CHECK, `this repo's listCaptures() threw — ${err.message}`);
}
if (!Array.isArray(captures))
  setupError(CHECK, 'listCaptures() returned no array of captures.');
const malformed = captures.filter(
  capture => capture === null || typeof capture !== 'object' || !('body' in capture)
);
if (malformed.length)
  setupError(
    CHECK,
    `listCaptures() returned ${malformed.length} entry(ies) without a \`body\`.`
  );

console.log(
  `${CHECK}: ${live.length} captured bodies · ${promoted.length} new vs HEAD · ${captures.length} captures on disk`
);

if (promoted.length === 0 || captures.length === 0)
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: 'promoted bodies matched to a capture',
    vacuousReason:
      promoted.length === 0
        ? 'No captured body is new against HEAD, so no promotion was available to adjudicate.'
        : `${promoted.length} body(ies) are new against HEAD, but no capture is on disk to match them\n` +
          '  against. Captures are normally gitignored, so a fresh clone and CI both have none.',
  });

const unmatched = [];
const matched = [];
for (const body of promoted) {
  let value;
  try {
    value = await readBody(absolute(body.relative));
  } catch (err) {
    setupError(CHECK, `could not read ${body.relative} — ${err.message}`);
  }
  // A capture whose own `body` is undefined then matches, and the promotion is reported adjudicated
  // having compared nothing — the same hollow count `verbatim` guards against.
  if (value === undefined)
    setupError(
      CHECK,
      `this repo's readBody returned undefined for ${body.relative}, so there was no value to match.\n` +
        '  A body module with no default export reads this way — check what readBody takes off the\n' +
        '  module it imports.'
    );
  const hit = captures.find(capture => deepEq(value, capture.body));
  if (hit) matched.push({ body, label: hit.label });
  else unmatched.push(body);
}

for (const m of matched)
  console.log(`  ${m.body.relative}  ←  ${m.label ?? 'unlabelled capture'}`);

const unpromoted = captures.filter(
  capture => !matched.some(m => m.label === capture.label)
);
if (unpromoted.length)
  console.log(
    `\n  note: ${unpromoted.length} capture(s) on disk were not promoted to any body.`
  );

finish({
  check: CHECK,
  assertedCount: promoted.length,
  assertedUnit: 'promoted bodies matched to a capture',
  failures: unmatched.map(
    body => `${body.relative}: matches no capture on disk`
  ),
  remediation:
    `  A body under ${CAPTURED_ORIGIN}/ is a wire record, so it must equal the capture it came from,\n` +
    '  value for value. Either it was authored or adjusted by hand — in which case it belongs in the\n' +
    '  authored bucket — or its capture has been cleared, in which case re-capture it.',
  pass: 'every newly promoted body matches a capture on disk',
});
