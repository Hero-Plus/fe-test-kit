// The placeholder shapes, built over one repo's wire conventions. Each keeps the captured value's
// type and the format class a consumer could depend on: an email stays an email, a URL stays a URL,
// a digit string keeps its exact length. The counter makes distinct captured values stay distinct
// without the script naming any of them.
//
// A factory rather than a module of constants because four of the shapes cannot be written without
// knowing what one backend's references, terminal ids and masks look like. Those values arrive as
// `conventions` so this file carries none of them.

const isPositiveInteger = value => Number.isInteger(value) && value > 0;
const isFilledString = value => typeof value === 'string' && value.length > 0;

// Value, not presence: a present-but-wrong convention is the dangerous case, because an invalid
// regex quantifier is legal *literal* text to `RegExp`. `cardTailDigits: null` builds `\d{null}`,
// which matches nothing, so `schemeLabel` returns the captured card tail verbatim — and the
// pipeline's own self-checks cannot see it, since they only compare a value against its
// replacement and here there is no replacement. So each value is checked against what its shape
// does with it, and a bad one stops the run rather than writing a corpus redacted less than before.
const CONVENTIONS = {
  networkReferencePrefixes: {
    must: 'a non-empty array of non-empty strings',
    ok: value =>
      Array.isArray(value) && value.length > 0 && value.every(isFilledString),
  },
  terminalIdOrdinalDigits: {
    must: 'a positive integer',
    ok: isPositiveInteger,
  },
  maskedPanMask: { must: 'a non-empty string', ok: isFilledString },
  cardTailDigits: { must: 'a positive integer', ok: isPositiveInteger },
};

function assertConventions(conventions) {
  const unusable = Object.entries(CONVENTIONS)
    .filter(([name, { ok }]) => !ok(conventions?.[name]))
    .map(
      ([name, { must }]) =>
        `${name} must be ${must} — got ${JSON.stringify(conventions?.[name])}`
    );
  if (unusable.length > 0) {
    throw new Error(
      `makeShapes cannot build a placeholder over ${unusable.length} wire convention(s):\n  ` +
        `${unusable.join('\n  ')}\n` +
        `They are declared as WIRE_CONVENTIONS in this repo's fixture config.`
    );
  }
}

const escapeForRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function makeShapes(conventions) {
  assertConventions(conventions);
  const {
    networkReferencePrefixes,
    terminalIdOrdinalDigits,
    maskedPanMask,
    cardTailDigits,
  } = conventions;

  // Per call, not per module: classify.mjs re-imports classification.mjs with a cache-buster to
  // verify its own edit, and a module-scope registry would hand that second run the first run's
  // ordinals instead of the fresh numbering it is checking.
  const registries = new Map();

  function ordinal(bucket, value) {
    if (!registries.has(bucket)) registries.set(bucket, new Map());
    const seen = registries.get(bucket);
    if (!seen.has(value)) seen.set(value, seen.size + 1);
    return seen.get(value);
  }

  // Each shape owns a fixed bucket, so one captured value maps to one placeholder no matter which
  // key name carries it. Bucketing per key name instead would leave every cross-key equality on the
  // wire — `acquirer_mid` == `nomupay_payin_entity_id`, `last4` == `card_details.last_four` —
  // holding only by the accident of both values happening to be encountered first in their own
  // registry.
  const label = text => value => `${text} ${ordinal(text, value)}`;
  const email = value => `redacted-${ordinal('email', value)}@example.test`;
  const url = value =>
    `https://assets.example.test/redacted-${ordinal('url', value)}`;
  const lastFour = value =>
    String(ordinal('last-four', value)).padStart(cardTailDigits, '9');

  // Preserves each character's class and every separator, not just length. A consumer that validates
  // `acquirer_mid` as hex or splits `bank_routing_number` on its `-` would behave differently
  // against a corpus that flattened both to digits.
  const sameClass = value => {
    // A hex value keeps a hex alphabet — emitting `h` into an `acquirer_mid` or a 2c2p token would
    // reintroduce exactly the class change this shape exists to avoid.
    const alphabetSize = /^[0-9a-f\W_]+$/i.test(value) ? 6 : 10;
    let remaining = ordinal('same-class', value);
    // Mixed-radix rather than a repeated filler: two captured values must not be able to collide.
    const rewritten = [...value].reverse().map(character => {
      if (!/[0-9a-z]/i.test(character)) return character;
      const size = /[0-9]/.test(character) ? 10 : alphabetSize;
      const index = remaining % size;
      remaining = Math.floor(remaining / size);
      if (/[0-9]/.test(character)) return String(index);
      const letter = String.fromCharCode(97 + index);
      return /[A-Z]/.test(character) ? letter.toUpperCase() : letter;
    });
    return rewritten.reverse().join('');
  };

  // The pre-commit scanner strips `-` before its Luhn check: an all-zero UUID is a valid PAN.
  const uuid = value =>
    `0000000a-000a-4000-a000-${String(ordinal('uuid', value)).padStart(12, '0')}`;

  const NETWORK_REFERENCE_PREFIX = new RegExp(
    `^(?:${networkReferencePrefixes.map(escapeForRegExp).join('|')})`
  );

  // A handle into the payment network. The prefix names the operation and is what the reference
  // cascade renders, so only the token after it is rewritten. A UUID tail is left as captured:
  // every one in this corpus is a record key we deliberately keep (`purchase.id`,
  // `payment_method.id`) echoed back by the PSP, so rewriting it would break a wire relation while
  // redacting nothing the corpus does not already carry.
  const networkReference = value => {
    const [prefix = ''] = NETWORK_REFERENCE_PREFIX.exec(value) ?? [];
    const tail = value.slice(prefix.length);
    return UUID_SHAPE.test(tail) ? value : `${prefix}${sameClass(tail)}`;
  };

  // A Stripe object id is a handle to a card on file. The `pm_` / `cus_` prefix names the object
  // type and is what makes the fixture legible as Stripe, so only the id after it is rewritten.
  const stripeObjectId = value => {
    const [prefix = ''] = /^[a-z]+_/.exec(value) ?? [];
    return `${prefix}${sameClass(value.slice(prefix.length))}`;
  };

  // Fixed-width acquirer terminal id: same length, same letter positions, digits neutralised.
  const terminalId = value =>
    value.replace(/\d/g, '0').slice(0, -terminalIdOrdinalDigits) +
    String(ordinal('terminal-id', value)).padStart(
      terminalIdOrdinalDigits,
      '0'
    );

  const maskedPan = value => {
    const [head, tail] = value.split(maskedPanMask);
    return `${sameClass(head)}${maskedPanMask}${lastFour(tail)}`;
  };

  // Origin and path only. The captured query carries a payment-session credential, and the
  // pre-commit secret scanner flags any `<known label>=<digit-bearing value>` — correctly, since a
  // committed fixture holding a credential-shaped query deserves a human decision even when the
  // value is synthetic. Rewriting the credential in place would keep tripping it, and picking a
  // value the rule happens to miss would be gaming a safety check. Nothing outside the fixtures
  // reads this field, so only its presence, type and endpoint are load-bearing, and all three
  // survive.
  const endpointOnly = value => value.split('?')[0];

  // An asset host inside a string that is otherwise kept — a pricing-plan HTML blob. No key-name
  // table can reach a URL living inside a value, so the shape rewrites it in place.
  const embeddedUrls = value =>
    value.replace(/https?:\/\/[^\s"'<>)]+/g, match => url(match));

  const CARD_TAIL = new RegExp(`\\d{${cardTailDigits}}`, 'g');

  // A display name is the scheme name on most rails ("Mastercard") but embeds the card tail on a
  // bank-instalment plan ("IPP Visa •••• 4242"). Rewriting only the digit run keeps the rendered
  // label intact while routing those digits through the same bucket as `last_four`, so all three
  // spellings of the tail still agree.
  const schemeLabel = value =>
    value.replace(CARD_TAIL, match => lastFour(match));

  // The shape vocabulary, by name. `classify.mjs` reads it so its refusal message can list the real
  // symbols a human must choose between when a new key needs a shape no existing one fits.
  return {
    label,
    email,
    url,
    lastFour,
    sameClass,
    uuid,
    networkReference,
    stripeObjectId,
    terminalId,
    maskedPan,
    endpointOnly,
    embeddedUrls,
    schemeLabel,
  };
}
