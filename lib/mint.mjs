// Mints a `merchant_user` fixture token, and runs the control flow around it that both consumer
// repos share so neither implements the dance itself.
//
// Staleness is read from the server, never from a clock: these JWTs carry `exp` in 2029 and the
// backend revokes them long before that, so an expiry check passes tokens that are already dead —
// measured, two of three credentials returned 401 while their `exp` read 2029-05-03.
import { redact } from './redact.mjs';
import {
  invalidateCachedToken,
  readCachedToken,
  writeCachedToken,
} from './token-cache.mjs';

export {
  cachePathFor,
  invalidateCachedToken,
  readCachedToken,
  writeCachedToken,
} from './token-cache.mjs';

const MINTABLE_HOSTS = Object.freeze([
  'dev.heroplusgroup.com',
  'staging.heroplusgroup.com',
]);
const PRODUCTION_HOST = 'app.heroplusgroup.com';

// Admitted because no real credential can exist on a name that never leaves this machine or resolves
// publicly — and because the control-flow proof is an HTTP stub on 127.0.0.1, which an allowlist of
// the two real hosts alone would refuse.
const RESERVED_SUFFIXES = Object.freeze([
  '.test',
  '.localhost',
  '.invalid',
  '.example',
]);
const LOOPBACK_PATTERN =
  /^(localhost|\[::1\]|::1|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

const SIGNUP_PATH = '/merchant_signup.json';
const SIGNIN_PATH = '/merchant_signin.json';

const REQUEST_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  // `TurnstileProtectable#mobile_app_request?` matches this exact string and short-circuits
  // `verify_turnstile!`, which is the whole reason this mints headlessly from any IP with no browser.
  // Without it signup renders 422 "Verification token required".
  'User-Agent': 'com.heroplusgroup.merchant_app',
});

// Every message this module emits or throws passes through here. The fixture credential's value is
// allowed to reach the cache file and nothing else — not a log, not a CI transcript, not a report —
// and quoting a response body on an error path is exactly how that leaks.
const BEARER_RUN = /Bearer\s+[\w-]+\.[\w-]+\.[\w-]+/gi;
const JWT_RUN = /eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g;
const withoutTokens = text =>
  String(text)
    .replace(BEARER_RUN, 'Bearer [REDACTED]')
    .replace(JWT_RUN, '[REDACTED]');

class MintError extends Error {
  constructor(code, message, options) {
    super(withoutTokens(message), options);
    this.name = 'MintError';
    this.code = code;
  }
}

/**
 * Refuses to mint anywhere a real merchant could exist. The fixture login is also a production
 * merchant's, and both an explicit host argument and `HP_DEV_API_URL` can point at production — so
 * the guard is on the resolved base URL rather than on whatever named it.
 */
export function assertMintableHost(baseUrl) {
  let hostname;
  try {
    // `.hostname`, not `.host`: a port says nothing about which environment this is.
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new MintError(
      'HOST_REFUSED',
      `Refusing to mint: ${JSON.stringify(baseUrl)} is not a URL, so the environment cannot be established.`
    );
  }

  if (
    MINTABLE_HOSTS.includes(hostname) ||
    LOOPBACK_PATTERN.test(hostname) ||
    RESERVED_SUFFIXES.some(suffix => hostname.endsWith(suffix))
  )
    return hostname;

  // Failing closed on an unknown host, rather than allowing everything but production, is what makes
  // adding an environment a decision someone takes rather than a default that happens.
  throw new MintError(
    'HOST_REFUSED',
    `Refusing to mint against ${hostname}. The fixture account is a live merchant login on ` +
      `${PRODUCTION_HOST}, so minting is allowed only on ${MINTABLE_HOSTS.join(' and ')}, plus ` +
      'loopback and reserved test names. Any other host is refused deliberately — adding one is a decision.'
  );
}

/**
 * Liberal in, strict out. Terminal strips the prefix on the way in (`bareJwt`, its
 * `tools/fixtures/lib/token.mjs:51-53`) and merchant stores it bare, while the cache file holds the
 * full string — normalising here is what keeps the cache byte-identical whichever shape arrives.
 */
const asBearer = token =>
  `Bearer ${String(token).trim().replace(/^Bearer\s+/i, '')}`;

async function describeFailure(response) {
  const text = await response.text().catch(() => '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.trim() === ''
      ? 'no body'
      : `an unparseable ${text.length}-byte body`;
  }

  // Only known error fields are ever quoted, and only after `redact` — a body is not the minter's to
  // read, and this is the one path where an unexpected field could carry a credential.
  const scrubbed = redact(parsed);
  const named = ['error_code', 'message', 'error', 'errors']
    .map(field => scrubbed?.[field])
    .filter(value => value !== undefined)
    .map(value => (typeof value === 'string' ? value : JSON.stringify(value)));
  return named.length > 0
    ? withoutTokens(named.join(' — '))
    : 'a body naming no error';
}

// The two endpoints are throttled by different rules, and a 429 does not say which one fired. Naming
// the wrong set would send a reader off to wait out a window that was never the constraint.
const THROTTLES = Object.freeze({
  [SIGNUP_PATH]:
    'Five independent throttles gate merchant_signup at once — ip/short 3 per minute, ip/long 5 per ' +
    'hour, phone 2 per 10 minutes, country_code 5 per 10 minutes, and a global 10 per minute',
  [SIGNIN_PATH]:
    'Two throttles gate merchant_signin — ip 10 per 5 minutes, and phone 5 per 5 minutes',
});

function rateLimited(endpoint, retryAfter) {
  const error = new MintError(
    'RATE_LIMITED',
    `${endpoint} returned 429, retry_after ${retryAfter ?? 'unstated'}s. ${THROTTLES[endpoint]} — ` +
      'so do not assume which one fired. Wait it out; a tight retry only deepens the window.'
  );
  error.retryAfter = retryAfter;
  return error;
}

async function readRetryAfter(response) {
  const header = Number(response.headers.get('retry-after'));
  const body = await response.json().catch(() => null);
  return Number(body?.retry_after) || header || null;
}

/**
 * The two POSTs, in this order — signin alone returns `401 "Incorrect verification code"`, because
 * signup is what issues the code that signin then presents. Returns the full `Bearer <jwt>`, which
 * the backend sends in signin's `authorization` *header* rather than its body.
 */
export async function mintToken({ baseUrl, account, fetchImpl }) {
  assertMintableHost(baseUrl);

  const fetcher = fetchImpl ?? globalThis.fetch;
  const { countryCode, phone, code, locale } = account ?? {};
  if (!countryCode || !phone || !code || !locale)
    throw new MintError(
      'BAD_ACCOUNT',
      'mintToken needs an account carrying countryCode, phone, code and locale — see resolveAccount.'
    );

  const root = String(baseUrl).replace(/\/+$/, '');
  const post = (endpoint, merchantUser) =>
    fetcher(root + endpoint, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: JSON.stringify({ merchant_user: merchantUser, locale }),
    });

  const signup = await post(SIGNUP_PATH, {
    country_code: countryCode,
    phone_number: phone,
  });
  if (signup.status === 429)
    throw rateLimited(SIGNUP_PATH, await readRetryAfter(signup));
  if (!signup.ok)
    throw new MintError(
      'SIGNUP_FAILED',
      `${SIGNUP_PATH} returned ${signup.status} — ${await describeFailure(signup)}`
    );

  const signin = await post(SIGNIN_PATH, {
    country_code: countryCode,
    phone_number: phone,
    password: code,
  });
  if (signin.status === 429)
    throw rateLimited(SIGNIN_PATH, await readRetryAfter(signin));

  const authorization = signin.headers.get('authorization');
  if (!authorization)
    throw new MintError(
      'NO_TOKEN',
      `${SIGNIN_PATH} returned ${signin.status} carrying no authorization header — ${await describeFailure(signin)}`
    );

  return asBearer(authorization);
}

const statusOf = value =>
  typeof value?.status === 'number'
    ? value.status
    : typeof value?.statusCode === 'number'
      ? value.statusCode
      : null;

// Consumers differ in how their HTTP client reports a rejection — one returns the response, the
// other throws — and D1's twenty-line wiring cannot afford either repo adapting to the other's shape.
async function attempt(perform, authorization) {
  try {
    const value = await perform(authorization);
    return { unauthorized: statusOf(value) === 401, value };
  } catch (error) {
    if (statusOf(error) === 401) return { unauthorized: true, error };
    throw error;
  }
}

/**
 * Runs `perform(authorization)` against a token that works, minting at most once per call:
 * cached → 401 → invalidate, mint once, retry once → still 401 → fail loudly, never a second mint.
 * An explicit token wins over the cache and is never written to it.
 *
 * `explicitTokenSource` names whatever supplied that token. The consuming repos read two different
 * environment variables, so a rejection can only tell the operator which secret to rotate if the
 * caller says which one it passed.
 */
export async function withFreshToken(
  {
    baseUrl,
    region,
    account,
    cacheDir,
    explicitToken,
    explicitTokenSource = 'explicitToken',
    fetchImpl,
  },
  perform
) {
  assertMintableHost(baseUrl);
  if (typeof perform !== 'function')
    throw new MintError(
      'BAD_CALL',
      'withFreshToken runs a perform(authorization) function, and was given none.'
    );

  const key = { baseUrl, region, cacheDir };

  if (explicitToken) {
    const supplied = await attempt(perform, asBearer(explicitToken));
    if (!supplied.unauthorized) return supplied.value;
    // An explicitly supplied token is not the minter's to own, so it is neither cached nor
    // substituted for: a dead CI secret has to stay visible as a dead CI secret rather than becoming
    // a mint on every run against a 5-per-hour budget.
    throw new MintError(
      'EXPLICIT_TOKEN_REJECTED',
      `The token supplied via ${explicitTokenSource} was rejected with 401. The minter does not ` +
        'replace a token you supplied — rotate that secret, or stop supplying it and let the minter ' +
        'mint and cache its own.',
      { cause: supplied.error }
    );
  }

  const cached = readCachedToken(key);
  if (cached) {
    const reused = await attempt(perform, cached);
    if (!reused.unauthorized) return reused.value;
    invalidateCachedToken(key);
  }

  const minted = await mintToken({ baseUrl, account, fetchImpl });
  // A sibling repo may have minted while this call was in flight. Its token is no older than ours —
  // the cache was empty when we started — and other processes can already see it, so converging on
  // it beats overwriting it with an equally good one.
  const sibling = readCachedToken(key);
  const authorization = sibling ?? minted;
  if (!sibling) writeCachedToken({ ...key, authorization: minted });

  const retried = await attempt(perform, authorization);
  if (!retried.unauthorized) return retried.value;

  throw new MintError(
    'STILL_UNAUTHORIZED',
    'A freshly minted token was rejected with 401 too. Not minting again — a second mint would ' +
      'spend one of 5 per hour on the same wrong answer. The account, the base URL or the ' +
      "endpoint's scope is what to look at.",
    { cause: retried.error }
  );
}
