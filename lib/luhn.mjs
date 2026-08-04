// What counts as a card number, in one place. The redactor and the corpus detector both read from
// here so they can never disagree about it — a value one of them scrubs and the other does not
// recognise would be a hole visible in neither.

// Real PANs are 13-19 digits (ISO/IEC 7812) and always pass Luhn. Both conditions together are what
// rule out the operational identifiers the wire carries that are otherwise digit-run lookalikes:
// rrn is exactly 12 digits, one short of the floor, and stan / trace_number / batch_number are
// shorter still. Single space or dash separators are allowed so a PAN echoed into free text
// ("4111 1111 1111 1111") is caught too, not only a bare digit run.
const SEPARATED_RUN_RE = /\b\d(?:[\d -]{11,24})\d\b/g;

// A second pattern rather than a looser first one, because `\b` is a *word* boundary and letters,
// digits and `_` are all word characters: it places no boundary between a letter and a digit, so
// `card4111111111111111` matches neither anchor above. Leaving the separated form on `\b` is what
// keeps a UUID's dash-joined digit sections ineligible — `ffb02414-5631-4996-…` strips to a
// Luhn-valid 13-digit run, and a recapture regenerates every UUID in the corpus, so matching those
// would redden the gate at random.
const BARE_RUN_RE = /(?<![0-9])\d{13,19}(?![0-9])/g;

// A card read arrives as hex TLV, which welds the tag and length bytes onto the digits: `5A08` + a
// 16-digit PAN is one 18-digit run that fails Luhn, so the two patterns above go silent on exactly
// the shape that carries real cardholder data. 18 nibbles is the shortest blob that can hold a tag,
// a length and a 13-digit PAN.
const HEX_TLV_RE = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{18,}(?![0-9A-Fa-f])/g;

// Exported only as the set: a consumer iterating one pattern and not the others reopens the hole
// above.
export const PAN_CANDIDATE_PATTERNS = [
  SEPARATED_RUN_RE,
  BARE_RUN_RE,
  HEX_TLV_RE,
];

export const digitsOf = run => run.replace(/[ -]/g, '');

export function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const PAN_TAG = '5A';
const TRACK2_TAG = '57';
// Contactless MSD (Mastercard PayPass), whose value is the same PAN + `D` + expiry layout as 57.
const TRACK2_MSD_TAG = '9F6B';
const MAX_TEMPLATE_DEPTH = 4;

const byteAt = (hex, at) => parseInt(hex.slice(at, at + 2), 16);

// BER-TLV, walked in nibble offsets. A tag byte with its low five bits all set continues into
// further bytes for as long as each carries the high bit; bit 0x20 marks the tag as a template
// holding more TLVs rather than a value.
function readTag(hex, at) {
  if (at + 2 > hex.length) return null;
  const first = byteAt(hex, at);
  let end = at + 2;
  if ((first & 0x1f) === 0x1f) {
    while (end + 2 <= hex.length) {
      const next = byteAt(hex, end);
      end += 2;
      if ((next & 0x80) === 0) break;
    }
  }
  return { tag: hex.slice(at, end), constructed: (first & 0x20) !== 0, end };
}

function readLength(hex, at) {
  if (at + 2 > hex.length) return null;
  const first = byteAt(hex, at);
  if (first < 0x80) return { length: first, end: at + 2 };
  const count = first & 0x7f;
  // 0x80 alone is BER's indefinite form, which no card emits, and past four length bytes this is
  // not a card read. Refused rather than guessed — a guess invents a value from the bytes after.
  if (count === 0 || count > 4 || at + 2 + count * 2 > hex.length) return null;
  return {
    length: parseInt(hex.slice(at + 2, at + 2 + count * 2), 16),
    end: at + 2 + count * 2,
  };
}

// Descends into templates because 5A and 57 normally arrive inside one (`70`, `77`) rather than at
// the top level. A declared length running past the end of the blob yields the bytes that are
// there: a fixture holding a truncated card read still holds a card read.
function* primitives(hex, depth = 0) {
  let at = 0;
  while (at + 4 <= hex.length) {
    const tag = readTag(hex, at);
    if (!tag) return;
    const length = readLength(hex, tag.end);
    if (!length) return;
    const end = Math.min(length.end + length.length * 2, hex.length);
    const value = hex.slice(length.end, end);
    if (!tag.constructed) yield { tag: tag.tag, value };
    else if (depth < MAX_TEMPLATE_DEPTH) yield* primitives(value, depth + 1);
    at = end;
  }
}

// Only the value of a tag that IS a PAN field is Luhn-checked, never a digit run found somewhere
// inside the blob: roughly 1 in 10 arbitrary digit strings passes Luhn, so a window slid over the
// corpus's own 12-digit rrn / stan / trace_number would fire on nearly every run.
function panCandidates(hex) {
  const out = [];
  for (const { tag, value } of primitives(hex)) {
    // Tag 57 is track-2 equivalent — PAN, a `D` field separator, then expiry, service code and
    // discretionary data. Luhn over the whole value never passes, which would leave the swipe and
    // fallback path silent while tag 5A was covered.
    if (tag === TRACK2_TAG || tag === TRACK2_MSD_TAG)
      out.push(value.split('D')[0]);
    // An odd-length PAN is padded to a whole byte with a trailing F nibble.
    else if (tag === PAN_TAG) out.push(value.replace(/F+$/, ''));
  }
  return out;
}

const isPanNumber = digits => /^\d{13,19}$/.test(digits) && luhnValid(digits);

const MIN_CARD_GROUP = 4;
const MAX_CARD_GROUP = 6;

// The separated pattern is greedy and `matchAll` consumes what it matched, so `ref 12 4111 1111 1111
// 1111` arrives as one 18-digit run: Luhn fails over the combined digits and no shorter window is
// tried. Windows are held to card grouping — 4 to 6 digits a group, the last shorter for a 13-digit
// PAN written 4-4-4-1 — to stay off the population the 1-in-10 Luhn rate rules out: that bound
// excludes a UUID's 8- and 12-character sections and every `YYYY MM DD` shape, measured at 0 new
// hits over the corpus, 300k random v4 UUIDs and 120k separator-joined shapes vs 3.2% ungrouped.
function cardGroupedWindows(run) {
  const groups = run.split(/[ -]+/).filter(Boolean);
  const windows = [];
  for (let start = 0; start < groups.length; start++) {
    for (let end = start; end < groups.length; end++) {
      const window = groups.slice(start, end + 1);
      const grouped = window.every(
        (group, at) =>
          group.length <= MAX_CARD_GROUP &&
          (at === window.length - 1 || group.length >= MIN_CARD_GROUP)
      );
      if (grouped) windows.push(window.join(''));
    }
  }
  return windows;
}

// No already-masked suppression, deliberately. A run matched above holds only digits, separators
// and hex letters, so it can never itself contain a mask character — and testing the string
// *around* it instead is what let "xxxx 4111111111111111" ship its PAN whole.
export function isPanRun(run) {
  const value = digitsOf(run);
  if (isPanNumber(value)) return true;
  if (cardGroupedWindows(run).some(isPanNumber)) return true;
  return (
    /^[0-9A-Fa-f]+$/.test(value) &&
    panCandidates(value.toUpperCase()).some(isPanNumber)
  );
}
