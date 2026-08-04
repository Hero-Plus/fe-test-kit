#!/usr/bin/env node
// Named `-test` rather than `.test`: jest 30's default testMatch grew `?([mc])` and now claims
// `*.test.mjs`, so that spelling is collected by a runner that cannot execute node:test and fails
// the suite. Node's own runner discovers both spellings.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isPanRun, PAN_CANDIDATE_PATTERNS } from './luhn.mjs';

// Both consumers reach the detector this way — patterns first, `isPanRun` on each match — so a
// shape that fires here is one they catch, and a pattern that never matches is a silent hole no
// direct `isPanRun` call would expose.
function fires(text) {
  for (const pattern of PAN_CANDIDATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (isPanRun(match[0])) return true;
    }
  }
  return false;
}

describe('a card number in the clear', () => {
  for (const [shape, text] of [
    ['a bare run', '4111111111111111'],
    ['spaced into free text', 'customer gave 4111 1111 1111 1111 by phone'],
    ['welded to a word', 'card4111111111111111'],
    // A digit token beside the PAN is the only cover for the sub-window retry in `luhn.mjs`: the
    // greedy separated match swallows the neighbour and Luhn-fails over the combined digits.
    ['a digit token before it', 'ref 12 4111 1111 1111 1111'],
    ['a digit token after it', '4111 1111 1111 1111 12'],
    ['a digit token either side', 'inv 7 ref 12 4111 1111 1111 1111 34 ok'],
    [
      'a reference before it in json',
      '{"note":"REF 8891 4111 1111 1111 1111 approved"}',
    ],
    ['dashed, with a digit token before it', 'ref 12 4111-1111-1111-1111'],
    ['15 digits grouped 4-6-5, with a neighbour', 'ref 12 3782 822463 10005'],
    ['13 digits grouped 4-4-4-1, with a neighbour', 'ref 12 4222 2222 2222 2'],
  ]) {
    test(shape, () => assert.equal(fires(text), true));
  }
});

describe('a card number packed into EMV TLV', () => {
  for (const [shape, text] of [
    ['tag 5A, length 08, packed BCD', '5A084111111111111111'],
    ['tag 5A with a trailing byte', '5A0841111111111111112F'],
    ['tag 5A inside a TLV chain', '9F1A0207025A084111111111111111'],
    // An odd-length PAN is padded to a whole byte, so the value is not a digit string at all.
    ['tag 5A, 15-digit PAN, F-padded', '5A08378282246310005F'],
    // Tag 57 is the swipe and fallback path. Its value is PAN + `D` + expiry + service code +
    // discretionary data, so Luhn over the whole value never passes and the split at `D` is what
    // fires. The discretionary tail here is Luhn-INVALID on purpose: `D` is a non-digit, so a
    // Luhn-valid tail is a bare-run candidate in its own right and these two cases would keep
    // passing with the split deleted.
    ['tag 57 track-2 equivalent', '57104111111111111111D25122011234568F'],
    ['tag 57 inside a 70 template', '701257104111111111111111D25122011234568F'],
    // Tag 9F6B is contactless MSD — the same PAN + `D` + expiry layout as 57, reached by the same
    // split.
    ['tag 9F6B contactless MSD', '9F6B104111111111111111D25122011234568F'],
    [
      'tag 9F6B inside a 70 template',
      '70229F6B104111111111111111D25122011234568F',
    ],
  ]) {
    test(shape, () => assert.equal(fires(text), true));
  }
});

describe('the operational identifiers the corpus carries', () => {
  for (const [shape, text] of [
    // Luhn-valid at 12 digits, taken from the corpus: roughly 1 in 10 arbitrary digit strings is,
    // so it is the 13-digit floor and not the checksum keeping every rrn silent.
    ['a Luhn-valid rrn', '"rrn": "620914000018"'],
    ['an rrn', '"rrn": "620911000006"'],
    ['a Luhn-valid trace_number', '"trace_number": "000018"'],
    ['a stan', '"stan": "000042"'],
    ['a uuid', '"id": "ffb02414-5631-4996-8a2f-1c3d5e7f9012"'],
    ['a pre-masked pan', '"masked_pan": "541333******9999"'],
    ['a hex digest', '"etag": "9f86d081884c7d659a2feaa0c55ad015"'],
    // Both fire if the sub-window retry accepts groups outside card grouping, and a recapture draws
    // fresh uuids every time — so these two are what hold the retry's bound rather than illustrate
    // it. The uuid's first three sections are all digits, which is the 1-in-1258 draw that reaches
    // a 16-digit window.
    ['a dashed date range', '"period": "2026-01-09 - 2026-02-09"'],
    // Windowed from the published Visa test vector: the commit secret scan rejects any other
    // Luhn-valid run, and a Luhn-invalid uuid would pass on the checksum and stop testing the bound.
    [
      'a uuid of leading all-digit sections',
      '"id": "41111111-1111-1111-9655-a8566b4aefbe"',
    ],
  ]) {
    test(shape, () => assert.equal(fires(text), false));
  }
});
