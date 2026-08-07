#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import { writeFileSync } from 'node:fs';

import { DEFAULT_ACCOUNTS, resolveAccount } from './fixture-accounts.mjs';
import {
  assertMintableHost,
  cachePathFor,
  mintToken,
  readCachedToken,
  withFreshToken,
  writeCachedToken,
} from './mint.mjs';

// Two real tokens live in the default cache directory, minted against a 5-per-hour budget, and
// `invalidateCachedToken` deletes files. Every case below passes an explicit `cacheDir`; this makes
// the default unreachable as well, so one forgotten argument cannot destroy them.
// The accounts file is pointed at nothing so that a developer's own
// `~/.heroplus/fixture-accounts.json` cannot decide whether the kit's tests pass — this suite runs in
// every consumer's `fixtures:verify`, and the CLI resolves its account through that file.
const SANDBOX = mkdtempSync(path.join(tmpdir(), 'hp-fixtures-mint-'));
const NO_ACCOUNTS_FILE = path.join(SANDBOX, 'no-such-accounts.json');
process.env.HP_FIXTURE_TOKEN_DIR = SANDBOX;
process.env.HP_FIXTURE_ACCOUNTS_FILE = NO_ACCOUNTS_FILE;
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

const ROOT_MINT = fileURLToPath(new URL('../mint.mjs', import.meta.url));

// JWT-shaped on purpose: the scrubber that keeps these out of stdout matches the shape, so a
// stand-in like "token-1" would let a leak through the test unnoticed.
const jwt = suffix =>
  `eyJhbGciOiJIUzI1NiJ9.eyJzY3AiOiJtZXJjaGFudF91c2VyIn0.stub-signature-${suffix}`;
const TOKEN_FIRST = jwt('first');
const TOKEN_SECOND = jwt('second');
const TOKEN_SIBLING = jwt('sibling');

const ACCOUNT = {
  countryCode: '+852',
  phone: '98999999',
  code: '111111',
  locale: 'en-HK',
};

function startStub(options = {}) {
  const calls = { signup: 0, signin: 0, probe: 0 };
  const seen = { signupUserAgent: null, signinUserAgent: null };
  const state = {
    signupStatus: 200,
    signinStatus: 200,
    tokens: [TOKEN_FIRST],
    acceptMinted: true,
    validToken: null,
    retryAfter: 2082,
    signinBody: null,
    withholdAuthHeader: false,
    onSignin: null,
    ...options,
  };

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };

      if (req.url.startsWith('/merchant_signup.json')) {
        calls.signup += 1;
        seen.signupUserAgent = req.headers['user-agent'] ?? null;
        if (state.signupStatus === 429)
          return json(
            429,
            {
              status: 'error',
              message: 'Too many attempts for this phone number.',
              error_code: 'RATE_LIMITED',
              retry_after: state.retryAfter,
            },
            { 'Retry-After': String(state.retryAfter) }
          );
        if (state.signupStatus !== 200)
          return json(state.signupStatus, {
            error_code: 'INVALID',
            message: 'Verification token required',
          });
        return json(200, { merchant_user: { id: 'stub-merchant' } });
      }

      if (req.url.startsWith('/merchant_signin.json')) {
        calls.signin += 1;
        seen.signinUserAgent = req.headers['user-agent'] ?? null;
        if (state.signinStatus === 429)
          return json(
            429,
            {
              status: 'error',
              message: 'Too many sign-in attempts.',
              error_code: 'RATE_LIMITED',
              retry_after: state.retryAfter,
            },
            { 'Retry-After': String(state.retryAfter) }
          );
        const token = state.tokens.shift() ?? TOKEN_SECOND;
        if (state.acceptMinted) state.validToken = token;
        state.onSignin?.(token);
        return json(
          200,
          state.signinBody?.(token) ?? { merchant_user: { id: 'stub-merchant' } },
          state.withholdAuthHeader ? {} : { authorization: `Bearer ${token}` }
        );
      }

      if (req.url.startsWith('/probe.json')) {
        calls.probe += 1;
        const sent = req.headers.authorization;
        return sent === `Bearer ${state.validToken}`
          ? json(200, { ok: true })
          : json(401, { error_code: 'UNAUTHORIZED', message: 'Unauthorized' });
      }

      return json(404, { error_code: 'NOT_FOUND' });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        calls,
        seen,
        state,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise(done => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

async function withStub(options, body) {
  const stub = await startStub(options);
  const cacheDir = mkdtempSync(path.join(SANDBOX, 'case-'));
  const key = { baseUrl: stub.url, region: 'HK', cacheDir };
  const probe = authorization =>
    fetch(`${stub.url}/probe.json`, { headers: { Authorization: authorization } });
  try {
    await body({ stub, cacheDir, key, probe });
  } finally {
    await stub.close();
  }
}

// Spawned asynchronously because the stub the child talks to is served by *this* process:
// `spawnSync` would block this event loop until the child exits, and the child is waiting on a reply
// only this loop can send.
const run = (args, env = {}) =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [ROOT_MINT, ...args], {
      env: { ...process.env, HP_FIXTURE_TOKEN_DIR: SANDBOX, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
    child.on('close', status => resolve({ status, stdout, stderr }));
  });

describe('the account table resolves in the documented order', () => {
  // Every case names an explicit `machineFile`, including the ones testing the lower tiers: left to
  // the default they would read whatever this machine happens to carry, and pass or fail by accident.
  const absent = NO_ACCOUNTS_FILE;

  const machineFileHolding = accounts => {
    const file = path.join(mkdtempSync(path.join(SANDBOX, 'accounts-')), 'a.json');
    writeFileSync(file, JSON.stringify(accounts));
    return file;
  };

  test('the kit default is the last resort, and carries the three regions', () => {
    assert.deepEqual(Object.keys(DEFAULT_ACCOUNTS), ['TH', 'HK', 'MY']);
    assert.equal(resolveAccount('HK', { machineFile: absent }).phone, '98999999');
    assert.equal(resolveAccount('MY', { machineFile: absent }).locale, 'en-MY');
    assert.equal(resolveAccount('TH', { machineFile: absent }).countryCode, '+66');
  });

  test('a repo table outranks the kit default', () => {
    const resolved = resolveAccount('HK', {
      machineFile: absent,
      repoAccounts: { HK: { ...DEFAULT_ACCOUNTS.HK, phone: '90000000' } },
    });
    assert.equal(resolved.phone, '90000000');
  });

  test('the machine file outranks both', () => {
    const resolved = resolveAccount('HK', {
      machineFile: machineFileHolding({
        HK: { ...DEFAULT_ACCOUNTS.HK, phone: '91111111' },
      }),
      repoAccounts: { HK: { ...DEFAULT_ACCOUNTS.HK, phone: '90000000' } },
    });
    assert.equal(resolved.phone, '91111111');
  });

  test('a region the machine file does not carry falls through, not away', () => {
    const machineFile = machineFileHolding({
      HK: { ...DEFAULT_ACCOUNTS.HK, phone: '91111111' },
    });
    assert.equal(resolveAccount('MY', { machineFile }).phone, '162856899');
  });

  test('the region is matched case-insensitively and reported upper-case', () => {
    assert.equal(resolveAccount('hk', { machineFile: absent }).region, 'HK');
  });

  // A half-filled override otherwise reaches the wire and returns a 422 naming a field, with nothing
  // pointing back at which of the three tiers supplied it.
  test('a half-filled override is refused, and the message names its source', () => {
    const machineFile = machineFileHolding({ HK: { countryCode: '+852' } });
    assert.throws(() => resolveAccount('HK', { machineFile }), error => {
      assert.match(error.message, /phone, code, locale/);
      assert.match(error.message, new RegExp(machineFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  });

  test('an unknown region is refused rather than silently defaulted', () => {
    assert.throws(
      () => resolveAccount('SG', { machineFile: absent }),
      /No fixture account for region SG/
    );
  });

  test('unreadable JSON is refused without quoting the file', () => {
    const file = path.join(mkdtempSync(path.join(SANDBOX, 'accounts-')), 'a.json');
    writeFileSync(file, '{ "HK": broken');
    assert.throws(() => resolveAccount('HK', { machineFile: file }), error => {
      assert.match(error.message, /not readable JSON/);
      assert.ok(!error.message.includes('broken'));
      return true;
    });
  });
});

describe('the production guard refuses on the resolved base URL', () => {
  test('production is refused, and the message names it', () => {
    assert.throws(
      () => assertMintableHost('https://app.heroplusgroup.com'),
      /app\.heroplusgroup\.com/
    );
  });

  test('the two real environments are mintable', () => {
    assert.equal(
      assertMintableHost('https://dev.heroplusgroup.com'),
      'dev.heroplusgroup.com'
    );
    assert.equal(
      assertMintableHost('https://staging.heroplusgroup.com/'),
      'staging.heroplusgroup.com'
    );
  });

  // Without this clause the guard would refuse the stub that proves every other case in this file.
  test('loopback and reserved names are mintable', () => {
    assert.equal(assertMintableHost('http://127.0.0.1:8080'), '127.0.0.1');
    assert.equal(assertMintableHost('http://localhost:3000'), 'localhost');
    assert.equal(assertMintableHost('https://api.test'), 'api.test');
    assert.equal(assertMintableHost('https://anything.localhost'), 'anything.localhost');
  });

  test('an unknown heroplus host is refused, so adding one stays a decision', () => {
    assert.throws(() => assertMintableHost('https://uat.heroplusgroup.com'), {
      code: 'HOST_REFUSED',
    });
  });

  test('a base URL that is not a URL is refused rather than assumed', () => {
    assert.throws(() => assertMintableHost('dev.heroplusgroup.com'), {
      code: 'HOST_REFUSED',
    });
  });

  test('minting is guarded even when mintToken is called directly', async () => {
    await assert.rejects(
      mintToken({ baseUrl: 'https://app.heroplusgroup.com', account: ACCOUNT }),
      { code: 'HOST_REFUSED' }
    );
  });
});

describe('the cache key is the contract two repos share', () => {
  const dir = '/tmp/does-not-matter';

  // The literals, not a re-run of the implementation's own formula: two tokens already sit on disk
  // under these exact names, and a key that regenerates differently silently mints over them.
  test('the seeded filenames are reproduced byte for byte', () => {
    assert.equal(
      path.basename(
        cachePathFor({ baseUrl: 'https://dev.heroplusgroup.com', region: 'HK', cacheDir: dir })
      ),
      'dev.heroplusgroup.com--HK.tok'
    );
    assert.equal(
      path.basename(
        cachePathFor({ baseUrl: 'https://dev.heroplusgroup.com/', region: 'my', cacheDir: dir })
      ),
      'dev.heroplusgroup.com--MY.tok'
    );
  });

  test('a port is part of the key', () => {
    assert.equal(
      path.basename(
        cachePathFor({ baseUrl: 'http://127.0.0.1:54321', region: 'HK', cacheDir: dir })
      ),
      '127.0.0.1_54321--HK.tok'
    );
    assert.notEqual(
      cachePathFor({ baseUrl: 'http://127.0.0.1:54321', region: 'HK', cacheDir: dir }),
      cachePathFor({ baseUrl: 'http://127.0.0.1:54322', region: 'HK', cacheDir: dir })
    );
  });

  test('a region that would escape the cache directory is refused', () => {
    assert.throws(
      () => cachePathFor({ baseUrl: 'https://dev.heroplusgroup.com', region: '../../etc/passwd', cacheDir: dir }),
      /cannot key a cache file/
    );
  });

  test('the cache file is 0600 inside a 0700 directory', () => {
    const cacheDir = mkdtempSync(path.join(SANDBOX, 'modes-'));
    const nested = path.join(cacheDir, 'fixture-tokens');
    const file = writeCachedToken({
      baseUrl: 'https://dev.heroplusgroup.com',
      region: 'HK',
      cacheDir: nested,
      authorization: `Bearer ${TOKEN_FIRST}`,
    });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(nested).mode & 0o777, 0o700);
  });

  test('a bare JWT is refused rather than silently stored in the wrong shape', () => {
    assert.throws(
      () =>
        writeCachedToken({
          baseUrl: 'https://dev.heroplusgroup.com',
          region: 'HK',
          cacheDir: SANDBOX,
          authorization: TOKEN_FIRST,
        }),
      /Bearer/
    );
  });
});

describe('withFreshToken mints once, reuses, and never loops', () => {
  test('an empty cache mints, caches, and performs', async () => {
    await withStub({}, async ({ stub, key, probe }) => {
      const response = await withFreshToken({ ...key, account: ACCOUNT }, probe);

      assert.equal(response.status, 200);
      assert.equal(stub.calls.signup, 1);
      assert.equal(stub.calls.signin, 1);
      assert.equal(readCachedToken(key), `Bearer ${TOKEN_FIRST}`);
    });
  });

  test('a second call reuses the cache and sends no second signup', async () => {
    await withStub({}, async ({ stub, key, probe }) => {
      await withFreshToken({ ...key, account: ACCOUNT }, probe);
      const response = await withFreshToken({ ...key, account: ACCOUNT }, probe);

      assert.equal(response.status, 200);
      assert.equal(stub.calls.signup, 1);
      assert.equal(stub.calls.signin, 1);
      assert.equal(stub.calls.probe, 2);
    });
  });

  test('a 401 invalidates, mints once, and retries once', async () => {
    await withStub({ tokens: [TOKEN_SECOND] }, async ({ stub, key, probe }) => {
      stub.state.validToken = null;
      writeCachedToken({ ...key, authorization: `Bearer ${TOKEN_FIRST}` });

      const response = await withFreshToken({ ...key, account: ACCOUNT }, probe);

      assert.equal(response.status, 200);
      assert.equal(stub.calls.signup, 1);
      assert.equal(stub.calls.probe, 2);
      assert.equal(readCachedToken(key), `Bearer ${TOKEN_SECOND}`);
    });
  });

  test('a perform that throws its 401 is handled the same way', async () => {
    await withStub({ tokens: [TOKEN_SECOND] }, async ({ stub, key, probe }) => {
      stub.state.validToken = null;
      writeCachedToken({ ...key, authorization: `Bearer ${TOKEN_FIRST}` });

      const throwingProbe = async authorization => {
        const response = await probe(authorization);
        if (!response.ok) {
          const error = new Error('rejected');
          error.status = response.status;
          throw error;
        }
        return response;
      };

      const response = await withFreshToken({ ...key, account: ACCOUNT }, throwingProbe);

      assert.equal(response.status, 200);
      assert.equal(stub.calls.signup, 1);
    });
  });

  test('a still-401 after a fresh mint fails loudly and mints no second time', async () => {
    await withStub({ acceptMinted: false }, async ({ stub, key, probe }) => {
      writeCachedToken({ ...key, authorization: `Bearer ${TOKEN_FIRST}` });

      await assert.rejects(withFreshToken({ ...key, account: ACCOUNT }, probe), {
        code: 'STILL_UNAUTHORIZED',
      });
      assert.equal(stub.calls.signup, 1);
      assert.equal(stub.calls.signin, 1);
      assert.equal(stub.calls.probe, 2);
    });
  });

  test('a sibling process that minted first wins over our own mint', async () => {
    await withStub({}, async ({ stub, key, probe }) => {
      stub.state.onSignin = () => {
        writeCachedToken({ ...key, authorization: `Bearer ${TOKEN_SIBLING}` });
        stub.state.validToken = TOKEN_SIBLING;
      };

      const response = await withFreshToken({ ...key, account: ACCOUNT }, probe);

      assert.equal(response.status, 200);
      assert.equal(readCachedToken(key), `Bearer ${TOKEN_SIBLING}`);
    });
  });
});

describe('an explicitly supplied token is not the minter’s to own', () => {
  test('it wins over the cache and is never written to it', async () => {
    await withStub({}, async ({ stub, key, probe }) => {
      stub.state.validToken = TOKEN_SECOND;
      writeCachedToken({ ...key, authorization: `Bearer ${TOKEN_FIRST}` });

      const response = await withFreshToken(
        { ...key, account: ACCOUNT, explicitToken: TOKEN_SECOND },
        probe
      );

      assert.equal(response.status, 200);
      assert.equal(stub.calls.signup, 0);
      assert.equal(readCachedToken(key), `Bearer ${TOKEN_FIRST}`);
    });
  });

  test('a rejected one fails loudly rather than being silently replaced', async () => {
    await withStub({}, async ({ stub, key, probe }) => {
      stub.state.validToken = TOKEN_SECOND;

      await assert.rejects(
        withFreshToken({ ...key, account: ACCOUNT, explicitToken: TOKEN_FIRST }, probe),
        { code: 'EXPLICIT_TOKEN_REJECTED' }
      );
      assert.equal(stub.calls.signup, 0);
      assert.equal(readCachedToken(key), null);
    });
  });

  // The operator's next action is to rotate a secret, and the three repos read two different
  // variables — an unnamed one leaves them guessing which.
  test('the rejection names whatever supplied the token', async () => {
    await withStub({}, async ({ key, probe }) => {
      const named = await withFreshToken(
        {
          ...key,
          account: ACCOUNT,
          explicitToken: TOKEN_FIRST,
          explicitTokenSource: 'HP_DEV_ACCESS_TOKEN',
        },
        probe
      ).then(() => null, error => error);
      assert.match(named.message, /HP_DEV_ACCESS_TOKEN was rejected/);

      const unnamed = await withFreshToken(
        { ...key, account: ACCOUNT, explicitToken: TOKEN_FIRST },
        probe
      ).then(() => null, error => error);
      assert.match(unnamed.message, /explicitToken was rejected/);
    });
  });
});

describe('the package root carries the whole minter', () => {
  // Deep imports resolve only while this package ships no `exports` map, so the root is the surface
  // a consumer can rely on outliving that.
  test('every deep export is reachable from index.mjs, and is the same function', async () => {
    const [root, deep, accounts] = await Promise.all([
      import('../index.mjs'),
      import('./mint.mjs'),
      import('./fixture-accounts.mjs'),
    ]);

    for (const [name, value] of [
      ...Object.entries(deep),
      ...Object.entries(accounts),
    ])
      assert.equal(root[name], value, `${name} differs between the root and its module`);
  });

  test('the package still declares no exports map', async () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    );
    for (const field of ['exports', 'types', 'typesVersions'])
      assert.equal(manifest[field], undefined, `${field} would narrow subpath resolution`);
  });
});

describe('a 429 names what it cannot know', () => {
  const rejection = promise => promise.then(() => null, error => error);

  test('a signup 429 surfaces retry_after, names the five throttles, and does not retry', async () => {
    await withStub({ signupStatus: 429 }, async ({ stub, key, probe }) => {
      const error = await rejection(withFreshToken({ ...key, account: ACCOUNT }, probe));

      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.retryAfter, 2082);
      assert.match(error.message, /2082/);
      assert.match(error.message, /five/i);
      assert.match(error.message, /ip\/long 5 per hour/);
      assert.equal(stub.calls.signup, 1);
    });
  });

  test('a signin 429 names signin’s throttles, not signup’s', async () => {
    await withStub({ signinStatus: 429 }, async ({ stub, key, probe }) => {
      const error = await rejection(withFreshToken({ ...key, account: ACCOUNT }, probe));

      assert.equal(error.code, 'RATE_LIMITED');
      assert.match(error.message, /merchant_signin/);
      assert.match(error.message, /ip 10 per 5 minutes/);
      assert.doesNotMatch(error.message, /ip\/long 5 per hour/);
      assert.equal(stub.calls.signin, 1);
    });
  });
});

describe('the wire facts that make a headless mint possible', () => {
  // Nothing else here would notice this string going missing: signup then fails only against the live
  // backend, as a 422, having already spent one of five mints per hour to find out.
  test('both POSTs carry the blessed merchant-app user agent', async () => {
    await withStub({}, async ({ stub, key, probe }) => {
      await withFreshToken({ ...key, account: ACCOUNT }, probe);

      assert.equal(stub.seen.signupUserAgent, 'com.heroplusgroup.merchant_app');
      assert.equal(stub.seen.signinUserAgent, 'com.heroplusgroup.merchant_app');
    });
  });
});

describe('no token value reaches stdout or stderr', () => {
  test('a successful CLI run prints the cache path and nothing of the token', async () => {
    await withStub({}, async ({ stub, cacheDir, key }) => {
      const result = await run([
        '--base-url',
        stub.url,
        '--region',
        'HK',
        '--cache-dir',
        cacheDir,
      ]);

      assert.equal(result.status, 0);
      // Anti-vacuity: the search string has to be somewhere, or the two assertions below hold for
      // the wrong reason.
      assert.equal(readFileSync(cachePathFor(key), 'utf8'), `Bearer ${TOKEN_FIRST}`);
      assert.equal(result.stdout.trim(), cachePathFor(key));
      assert.ok(!result.stdout.includes(TOKEN_FIRST));
      assert.ok(!result.stderr.includes(TOKEN_FIRST));
    });
  });

  test('a failure that quotes the response body scrubs the token out of it', async () => {
    await withStub(
      {
        withholdAuthHeader: true,
        signinBody: token => ({
          message: `session opened with Bearer ${token}`,
          session: token,
        }),
      },
      async ({ stub, cacheDir }) => {
        const result = await run([
          '--base-url',
          stub.url,
          '--region',
          'HK',
          '--cache-dir',
          cacheDir,
        ]);

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /authorization header/);
        assert.ok(!result.stdout.includes(TOKEN_FIRST));
        assert.ok(!result.stderr.includes(TOKEN_FIRST));
        assert.ok(!result.stderr.includes('eyJ'));
      }
    );
  });

  test('a rate-limited CLI run exits non-zero and leaks nothing', async () => {
    await withStub({ signupStatus: 429 }, async ({ stub, cacheDir }) => {
      const result = await run([
        '--base-url',
        stub.url,
        '--region',
        'HK',
        '--cache-dir',
        cacheDir,
      ]);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /five/i);
      assert.ok(!result.stderr.includes('eyJ'));
    });
  });

  test('the CLI refuses production before it reaches the network', async () => {
    const result = await run([
      '--base-url',
      'https://app.heroplusgroup.com',
      '--region',
      'TH',
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /app\.heroplusgroup\.com/);
  });
});
