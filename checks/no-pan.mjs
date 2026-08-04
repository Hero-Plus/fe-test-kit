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
// Exit codes: 0 pass, 1 a card-number shape reached the corpus, 2 setup error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { VACUOUS } from '../lib/exit-codes.mjs';
import { digitsOf, isPanRun, PAN_CANDIDATE_PATTERNS } from '../lib/luhn.mjs';
import {
  FIXTURES_DIR,
  FIXTURES_RELATIVE,
  PAN_ALLOWLIST,
  PAN_ALLOWLIST_RELATIVE,
} from '../config.mjs';

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

if (!existsSync(root)) {
  console.error(
    `\nno-pan: asserted nothing — ${rootLabel} does not exist in this repo.`
  );
  console.error(
    '  Nothing to scan is not the same as nothing found, and this is a card-number scanner: a green\n' +
      '  run over an absent tree is the one result it must never report. Point HP_FIXTURES_CONFIG at\n' +
      '  the repo holding the corpus.'
  );
  process.exit(VACUOUS);
}

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
    if (!Array.isArray(allow)) {
      console.error(
        `no-pan: ${PAN_ALLOWLIST_RELATIVE} has an "allow" that is not an array.`
      );
      process.exit(2);
    }
    allowlist = allow;
  } catch (err) {
    console.error(
      `no-pan: ${PAN_ALLOWLIST_RELATIVE} is not valid JSON —`,
      err.message
    );
    process.exit(2);
  }
  const malformed = allowlist.filter(e => !e?.path || !e?.digits || !e?.reason);
  if (malformed.length) {
    // A reason is what makes an entry auditable, so an entry without one is not a weaker entry —
    // it is an undocumented suppression of a card-number match, which is the thing being guarded.
    console.error(
      `no-pan: ${malformed.length} allowlist entry(ies) missing path, digits or reason.`
    );
    process.exit(2);
  }
}

const isDir = statSync(root).isDirectory();
const files = isDir ? filesUnder(root) : [root];
// Reporting is relative to the scanned root, so a single file must be named from its parent — a
// path relative to itself is the empty string, and the hit would print with no file at all.
const base = isDir ? root : path.dirname(root);

console.log(`no-pan: scanning ${rootLabel} — ${files.length} file(s)`);
console.log(
  `  allowlist ${PAN_ALLOWLIST_RELATIVE}: ${allowlist.length} entry(ies)`
);

// The corpus directory existing but holding nothing is a broken run, not a clean one: mid-restructure
// or mis-pointed, this check would otherwise report a confident PASS having examined no bytes.
if (files.length === 0) {
  console.error(`\nno-pan: ${rootLabel} exists but holds no files to scan.`);
  process.exit(2);
}

// The same failure in miniature, and quieter: a symlink's Dirent reports as neither file nor
// directory, so an entry the walk cannot classify would drop out of the scan with nothing said and
// the PASS below would cover bytes never read.
if (unscannable.length > 0) {
  console.error(
    `\nno-pan: ${unscannable.length} entry(ies) under ${rootLabel} are neither a file nor a directory:`
  );
  for (const entry of unscannable)
    console.error(`  ${path.relative(base, entry)}`);
  console.error(
    '\n  A symlink is the usual cause. Replace it with the real file or move it out of the corpus.'
  );
  process.exit(2);
}

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
    console.error(`no-pan: could not read ${relative} — ${err.message}`);
    process.exit(2);
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

if (hits.length) {
  console.error(
    `\nFAIL — ${hits.length} card-number shape(s) with no allowlist entry:`
  );
  for (const h of hits) console.error(`  ${h.where}  ${h.run}`);
  console.error(
    '\n  Each is a card-number shape. Take the value out of the corpus, or — where it provably is\n' +
      `  not a PAN — add {path, digits, reason} to ${PAN_ALLOWLIST_RELATIVE}.\n` +
      '  Never resolve one by loosening the detector.'
  );
  process.exit(1);
}

console.log('\nPASS — no un-allowlisted card-number shape in the corpus');
