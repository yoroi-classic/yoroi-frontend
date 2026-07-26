import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptyAccountRequest,
  emptyAccountResources,
  emptyAccountState,
  emptyAddressRequest,
  emptyAddressRoutes,
} from './mockServer.js';

const paymentAddress =
  'addr_test1qp8tt4wxnt32h3fn63xkzh4q7ah57v330v40mc2e9ale5jp4ytssp23mthvgruacyluaa0f868fffgnch75082k8awhsc4l6ve';
const stakeAddress = 'stake1u8pcjgmx7962w6hey5hhsd502araxp26kdtgagakhaqtq8squng76';
const invalidRequest = { status: 400, body: { error: 'invalid fixture request' } };

test('registers only the empty address and account resources used by current adapters', () => {
  assert.deepEqual(emptyAddressRoutes, ['/v1/addresses/filter-used', '/v1/addresses/utxos', '/v1/addresses/txs']);
  assert.deepEqual(emptyAccountResources, ['utxos', 'txs', 'rewards']);
});

test('valid address discovery and sync requests return deterministic empty state', () => {
  assert.deepEqual(emptyAddressRequest({ addresses: [paymentAddress] }), { status: 200, body: [] });
});

test('malformed, empty, or oversized address batches fail closed', () => {
  for (const body of [
    {},
    { addresses: [] },
    { addresses: ['not-an-address'] },
    { addresses: [1] },
    { addresses: Array(1001).fill(paymentAddress) },
  ]) {
    assert.deepEqual(emptyAddressRequest(body), invalidRequest);
  }
});

test('valid account sync requests return deterministic empty state', () => {
  assert.deepEqual(emptyAccountRequest(stakeAddress), { status: 200, body: [] });
});

test('malformed account identifiers fail closed', () => {
  assert.deepEqual(emptyAccountRequest('not-a-stake-address'), invalidRequest);
});

test('the account-state fixture keeps protocol quantities as exact strings', () => {
  assert.deepEqual(emptyAccountState(stakeAddress), {
    stakeAddress,
    registered: false,
    balance: '0',
    rewardsAvailable: '0',
    rewardsSum: '0',
    withdrawalsSum: '0',
    delegatedPool: null,
    delegatedDrep: null,
  });
});
