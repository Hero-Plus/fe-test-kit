#!/usr/bin/env node
// Asserts no card number reaches the corpus — a bare Luhn-valid 13-19 digit run, or one packed
// into a hex TLV blob under tag 5A or 57 where the tag and length bytes break both.
//
// This is the free-text hole no key-name scrub table can close: the redaction pipeline classifies
// by key, so a card number a human typed into an order description, a remark or a customer name
// arrives under a key nothing marks as sensitive and ships. Nothing else in the repo reads values.
//
// It stays a byte scan over whole files rather than a walk over parsed JSON, so it covers the
// TypeScript bodies as well, and so a repo with no corpus loader — or no corpus yet — can adopt it
// as-is. That is also why a hit is reported as `file:line` and not as a JSON key path.
//
// Durable after commit: it reads only the working tree, invokes no git and pins against no HEAD.
//
// Usage: hp-fixtures-no-pan [--root <dir>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { digitsOf, isPanRun, PAN_CANDIDATE_PATTERNS } from '../lib/luhn.mjs';
import { finish, setupError } from '../lib/outcomes.mjs';
import {
  FIXTURES_DIR,
  FIXTURES_RELATIVE,
  PAN_ALLOWLIST,
  PAN_ALLOWLIST_RELATIVE,
} from '../config.mjs';

const CHECK = 'no-pan';

// The scan is scoped to the corpus rather than the tree: a whole-tree scan hits icon path data,
// where an all-zero run is Luhn-valid at every length in the range, and third-party test card
// numbers in documentation — this check's own examples included. Widening the scope would fail on
// day one for reasons that are not corpus defects.
function resolveRoot(argv) {
  const flag = argv.indexOf('--root');
  if (flag !== -1 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  const inline = argv.find(a => a.startsWith('--root='));
  if (inline) return path.resolve(inline.slice('--root='.length));
  return FIXTURES_DIR;
}

const root = resolveRoot(process.argv.slice(2));
const rootLabel = root === FIXTURES_DIR ? FIXTURES_RELATIVE : root;

if (!existsSync(root))
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: 'corpus files scanned',
    vacuousReason:
      `${rootLabel} does not exist in this repo.\n` +
      '  Nothing to scan is not the same as nothing found, and this is a card-number scanner: a green\n' +
      '  run over an absent tree is the one result it must never report. Point HP_FIXTURES_CONFIG at\n' +
      '  the repo holding the corpus.',
  });

const unscannable = [];

function filesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else if (entry.isFile()) out.push(full);
    else unscannable.push(full);
  }
  return out;
}

let allowlist = [];
if (existsSync(PAN_ALLOWLIST)) {
  try {
    const parsed = JSON.parse(readFileSync(PAN_ALLOWLIST, 'utf8'));
    // Refused here rather than left to throw on `.find` mid-walk, which surfaces as a crash instead
    // of the setup-error exit every other malformed allowlist takes.
    const allow = parsed.allow ?? [];
    if (!Array.isArray(allow))
      setupError(
        CHECK,
        `${PAN_ALLOWLIST_RELATIVE} has an "allow" that is not an array.`
      );
    allowlist = allow;
  } catch (err) {
    setupError(
      CHECK,
      `${PAN_ALLOWLIST_RELATIVE} is not valid JSON — ${err.message}`
    );
  }
  const malformed = allowlist.filter(e => !e?.path || !e?.digits || !e?.reason);
  // A reason is what makes an entry auditable, so an entry without one is not a weaker entry — it is
  // an undocumented suppression of a card-number match, which is the thing being guarded.
  if (malformed.length)
    setupError(
      CHECK,
      `${malformed.length} allowlist entry(ies) missing path, digits or reason.`
    );
}

const isDir = statSync(root).isDirectory();
const files = isDir ? filesUnder(root) : [root];
// Reporting is relative to the scanned root, so a single file must be named from its parent — a
// path relative to itself is the empty string, and the hit would print with no file at all.
const base = isDir ? root : path.dirname(root);

console.log(`${CHECK}: scanning ${rootLabel} — ${files.length} file(s)`);
console.log(
  `  allowlist ${PAN_ALLOWLIST_RELATIVE}: ${allowlist.length} entry(ies)`
);

if (files.length === 0)
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: 'corpus files scanned',
    vacuousReason: `${rootLabel} exists but holds no file to scan.`,
  });

// A symlink's Dirent reports as neither file nor directory, so an entry the walk cannot classify
// would drop out of the scan with nothing said, and the pass below would cover bytes never read.
if (unscannable.length > 0)
  setupError(
    CHECK,
    `${unscannable.length} entry(ies) under ${rootLabel} are neither a file nor a directory:\n` +
      unscannable.map(entry => `  ${path.relative(base, entry)}`).join('\n') +
      '\n  A symlink is the usual cause. Replace it with the real file or move it out of the corpus.'
  );

const hits = [];
const allowed = [];
const used = new Set();
let candidates = 0;

for (const file of files) {
  const relative = path.relative(base, file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    setupError(CHECK, `could not read ${relative} — ${err.message}`);
  }
  text.split('\n').forEach((line, index) => {
    // The patterns overlap: an unseparated run matches several, and the same number reported twice
    // on one line reads as two card numbers. Deduping on the run is exact, because `isPanRun` is a
    // function of them alone — two spellings of one number can never disagree about the verdict.
    const seen = new Set();
    for (const pattern of PAN_CANDIDATE_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const digits = digitsOf(match[0]);
        if (seen.has(digits)) continue;
        seen.add(digits);
        candidates += 1;
        if (!isPanRun(match[0])) continue;
        // Keyed by path and value, never by line: a reformat moves every line number in a file and
        // would silently retire the entries along with them.
        const entry = allowlist.find(
          e => e.path === relative && e.digits === digits
        );
        const where = `${relative}:${index + 1}`;
        if (entry) {
          used.add(entry);
          allowed.push({ where, digits, reason: entry.reason });
        } else hits.push({ where, run: match[0] });
      }
    }
  });
}

console.log(`  candidate runs examined: ${candidates}`);

if (allowed.length) {
  console.log(`\n  allowed by recorded entry: ${allowed.length}`);
  for (const a of allowed)
    console.log(`    ${a.where}  ${a.digits} — ${a.reason}`);
}

// Reported rather than failed: an entry stops matching whenever the corpus legitimately moves, and
// a stale reason is a documentation problem, not a card number reaching git.
const unused = allowlist.filter(e => !used.has(e));
if (unused.length) {
  console.log(
    `\n  note: ${unused.length} allowlist entry(ies) matched nothing and no longer document anything:`
  );
  for (const u of unused) console.log(`    ${u.path}  ${u.digits}`);
}

finish({
  check: CHECK,
  assertedCount: files.length,
  assertedUnit: 'corpus files scanned',
  failures: hits.map(h => `${h.where}  ${h.run}`),
  remediation:
    '  Each is a card-number shape. Take the value out of the corpus, or — where it provably is not a\n' +
    `  PAN — add {path, digits, reason} to ${PAN_ALLOWLIST_RELATIVE}.\n` +
    '  Never resolve one by loosening the detector.',
  pass: 'no un-allowlisted card-number shape in the corpus',
});
