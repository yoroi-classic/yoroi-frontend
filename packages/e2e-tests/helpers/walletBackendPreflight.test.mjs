import assert from 'node:assert/strict';
import test from 'node:test';
import { checkWalletBackend } from './walletBackendPreflight.mjs';

const response = body => ({ ok: true, status: 200, json: async () => body });

const healthyFetch = async url => {
  if (url.endsWith('/health')) return response({ status: 'ok' });
  if (url.endsWith('/v1/status')) {
    return response({ network: 'mainnet', provider: 'koios', chain: 'ok', tip: { block: 1 } });
  }
  if (url.endsWith('/v1/config')) return response({ server: { enabled: true } });
  throw new Error(`unexpected URL ${url}`);
};

test('accepts a healthy backend on the expected network', async () => {
  const status = await checkWalletBackend({
    endpoint: 'http://127.0.0.1:21000/',
    expectedNetwork: 'mainnet',
    fetchImpl: healthyFetch,
  });
  assert.equal(status.network, 'mainnet');
});

test('rejects a backend serving the wrong network', async () => {
  await assert.rejects(
    checkWalletBackend({ endpoint: 'http://127.0.0.1:21000', expectedNetwork: 'preprod', fetchImpl: healthyFetch }),
    /network is mainnet, expected preprod/
  );
});

test('rejects a backend whose chain provider is unavailable', async () => {
  const fetchImpl = async url => {
    if (url.endsWith('/health')) return response({ status: 'ok' });
    return response({ network: 'mainnet', provider: 'koios', chain: 'down', tip: null });
  };
  await assert.rejects(
    checkWalletBackend({ endpoint: 'http://127.0.0.1:21000', expectedNetwork: 'mainnet', fetchImpl }),
    /chain is down/
  );
});

test('rejects a backend whose remote config is in maintenance', async () => {
  const fetchImpl = async url => {
    if (url.endsWith('/health')) return response({ status: 'ok' });
    if (url.endsWith('/v1/status')) {
      return response({ network: 'mainnet', provider: 'koios', chain: 'ok', tip: { block: 1 } });
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
  await assert.rejects(
    checkWalletBackend({ endpoint: 'http://127.0.0.1:21000', expectedNetwork: 'mainnet', fetchImpl }),
    /v1\/config returned HTTP 503/
  );
});
