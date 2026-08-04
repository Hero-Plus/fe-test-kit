// Defense-in-depth scrub applied to a response before it touches disk. The backend already sends
// masked_pan pre-masked ("541333******9999"), so this should rarely fire in practice — it exists
// for the field the backend forgets to mask, and for whatever a future endpoint adds.
import { isPanRun, PAN_CANDIDATE_PATTERNS } from './luhn.mjs';

const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_RE =
  /^(pan|card_?number|clear_pan|full_pan|primary_account_number|track_?1|track_?2|track_?data|cvv2?|cvc2?|security_code|card_security_code|pin|pin_?block|ksn|access_token|auth_token|bearer|authorization)$/i;

const TOKEN_SUFFIX_RE = /_token$/i;

const redactPanShapedRuns = value =>
  PAN_CANDIDATE_PATTERNS.reduce(
    (text, pattern) =>
      text.replace(pattern, run => (isPanRun(run) ? REDACTED : run)),
    value
  );

// Under a key the table already calls sensitive, the value's shape decides nothing: a PIN nested
// one level down or a PAN arriving as a JSON number is the same secret, and neither is a shape the
// PAN scan would recognise. Booleans and nulls carry nothing and are kept so the shape stays
// readable.
function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = redactSensitive(v);
    return out;
  }
  return typeof value === 'string' || typeof value === 'number'
    ? REDACTED
    : value;
}

/** Deep-walks a JSON-shaped value, redacting by key name first and by value shape second. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] =
        SENSITIVE_KEY_RE.test(key) || TOKEN_SUFFIX_RE.test(key)
          ? redactSensitive(v)
          : redact(v);
    }
    return out;
  }
  if (typeof value === 'string') return redactPanShapedRuns(value);
  return value;
}

/** Same scrub for one-line debug/error output, so a logged request never carries a bearer token. */
export function redactHeaders(headers) {
  const out = { ...headers };
  // HTTP header names are case-insensitive and `fetch` lower-cases them on the way out, so matching
  // the capitalised spelling alone logs the token verbatim for every caller that does not use it.
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === 'authorization') out[key] = `Bearer ${REDACTED}`;
  }
  return out;
}
