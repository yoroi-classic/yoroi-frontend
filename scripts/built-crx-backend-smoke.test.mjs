import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateSmokeResult } from './built-crx-backend-smoke.mjs';

const backendOrigin = 'http://wallet-backend:3010';
const expectedNetwork = 'preprod';
const validResult = {
  hostPermissions: [`${backendOrigin}/*`],
  contentSecurityPolicy: `connect-src 'self' ${backendOrigin};`,
  status: { httpStatus: 200, body: { network: expectedNetwork, chain: 'ok', tip: { height: 1 } } },
  tip: { httpStatus: 200, body: { height: 1 } },
};

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('keeps the signed origin and self-contained topology wired together', () => {
  const config = JSON.parse(readFileSync(`${repositoryRoot}packages/yoroi-extension/config/backend-smoke.json`, 'utf8'));
  const compose = readFileSync(`${repositoryRoot}scripts/built-crx-backend-smoke.compose.yml`, 'utf8');
  const runner = readFileSync(`${repositoryRoot}scripts/run-built-crx-backend-smoke.sh`, 'utf8');

  assert.deepEqual(config.cardanoWalletBackend, {
    enabled: true,
    mainnet: backendOrigin,
    preprod: backendOrigin,
  });
  assert.match(compose, /wallet-backend:/);
  assert.match(compose, /selenium:/);
  assert.match(compose, /host\.docker\.internal:\$\{BACKEND_NODE_PORT/);
  assert.match(runner, /--configEnv backend-smoke/);
  assert.match(runner, /built-crx-backend-smoke\.mjs/);
  assert.doesNotMatch(runner, /docker\s+(?:compose\s+)?exec/);
});

test('accepts extension-context status and tip responses from the signed origin', () => {
  assert.doesNotThrow(() => validateSmokeResult({ result: validResult, backendOrigin, expectedNetwork }));
});

test('rejects a signed CRX without the tested backend origin', () => {
  assert.throws(
    () => validateSmokeResult({ result: { ...validResult, hostPermissions: [] }, backendOrigin, expectedNetwork }),
    /manifest does not permit/
  );
});

test('rejects the wrong backend network', () => {
  const result = { ...validResult, status: { ...validResult.status, body: { ...validResult.status.body, network: 'mainnet' } } };
  assert.throws(() => validateSmokeResult({ result, backendOrigin, expectedNetwork }), /expected preprod/);
});

test('rejects unhealthy status and malformed tip responses', () => {
  const unhealthy = { ...validResult, status: { ...validResult.status, body: { network: expectedNetwork, chain: 'down' } } };
  assert.throws(() => validateSmokeResult({ result: unhealthy, backendOrigin, expectedNetwork }), /expected ok with a tip/);
  assert.throws(
    () =>
      validateSmokeResult({ result: { ...validResult, tip: { httpStatus: 200, body: null } }, backendOrigin, expectedNetwork }),
    /chain tip response is invalid/
  );
});
