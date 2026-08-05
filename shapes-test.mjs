#!/usr/bin/env node
// Named `-test` rather than `.test`: jest 30's default testMatch claims `*.test.mjs`, and jest
// cannot execute node:test.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { makeShapes } from './shapes.mjs';

const USABLE_CONVENTIONS = Object.freeze({
  networkReferencePrefixes: Object.freeze(['ref-']),
  terminalIdOrdinalDigits: 3,
  maskedPanMask: '******',
  cardTailDigits: 4,
});

describe('a wire convention whose value cannot build its shape', () => {
  for (const [name, shape, value] of [
    ['cardTailDigits', 'null', null],
    ['cardTailDigits', 'an empty string', ''],
    ['cardTailDigits', 'negative', -1],
    ['cardTailDigits', 'fractional', 3.5],
    ['cardTailDigits', 'zero', 0],
    ['cardTailDigits', 'a numeric string', '4'],
    ['terminalIdOrdinalDigits', 'null', null],
    ['terminalIdOrdinalDigits', 'zero', 0],
    ['terminalIdOrdinalDigits', 'fractional', 1.5],
    ['maskedPanMask', 'null', null],
    ['maskedPanMask', 'an empty string', ''],
    ['networkReferencePrefixes', 'null', null],
    ['networkReferencePrefixes', 'an empty array', []],
    ['networkReferencePrefixes', 'an empty entry', ['']],
    ['networkReferencePrefixes', 'a bare string', 'ref-'],
  ]) {
    test(`${name} is ${shape}`, () =>
      assert.throws(
        () => makeShapes({ ...USABLE_CONVENTIONS, [name]: value }),
        new RegExp(name)
      ));
  }

  test('no conventions at all', () =>
    assert.throws(() => makeShapes(undefined), /cardTailDigits/));

  // The throws above pass just as well against a shape that redacts nothing, so one case has to
  // assert the replacement: `schemeLabel` is the only shape that reaches a card tail inside a value
  // the corpus otherwise keeps whole.
  test('a usable set replaces the card tail inside a kept label', () => {
    const { schemeLabel } = makeShapes(USABLE_CONVENTIONS);
    assert.equal(schemeLabel('Visa •••• 4242'), 'Visa •••• 9991');
  });
});
