import assert from 'node:assert/strict';
import test from 'node:test';

import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs';

import { MockDAppWebpage } from './mockedDApp.js';
import {
  addressToCbor,
  addressesFromCborIfNeeded,
  getAmountInHex,
  getCmlValue,
  getKeyHashFromHex,
  mapCborUtxos,
  toInt,
} from './dAppTxHelper.js';
import { buildSimpleTx } from './dAppHelper.js';

const paymentAddress = 'addr1qxxvt9rzpdxxysmqp50d7f5a3gdescgrejsu7zsdxqjy8yun4cngaq46gr8c9qyz4td9ddajzqhjnrqvfh0gspzv9xnsmq6nqx';

const makeUtxo = (index = 3n, amount = 20000000n) =>
  CML.TransactionUnspentOutput.new(
    CML.TransactionInput.new(CML.TransactionHash.from_hex('11'.repeat(32)), index),
    CML.TransactionOutput.new(CML.Address.from_bech32(paymentAddress), CML.Value.from_coin(amount))
  );

test('address bytes and CIP-30 address strings round-trip through CML', () => {
  const address = CML.Address.from_bech32(paymentAddress);
  const addressHex = addressToCbor(paymentAddress);

  assert.equal(
    addressHex,
    '018cc594620b4c6243600d1edf269d8a1b986103cca1cf0a0d3024439393ae268e82ba40cf828082aada56b7b2102f298c0c4dde88044c29a7'
  );
  assert.equal(addressHex, address.to_hex());
  assert.deepEqual(addressesFromCborIfNeeded([addressHex]), [paymentAddress]);
});

test('CML helpers preserve integer quantities above JavaScript safe integer range', () => {
  const amount = '9007199254740993';
  assert.equal(getCmlValue(getAmountInHex(amount)).coin().toString(), amount);
  assert.equal(toInt(amount).to_str(), amount);
  assert.equal(toInt('-17').to_str(), '-17');
  assert.throws(() => toInt('1.5'), /integer/);
  assert.throws(() => toInt(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
});

test('mocked dApp returns CML coin balances as decimal strings', async () => {
  const driver = {
    executeAsyncScript: async () => ({
      success: true,
      retValue: CML.Value.from_coin(9007199254740993n).to_cbor_hex(),
    }),
  };
  const logger = { info: () => {} };
  const mockedDApp = new MockDAppWebpage(driver, logger);

  assert.deepEqual(await mockedDApp.getBalance(), {
    success: true,
    retValue: '9007199254740993',
  });
});

test('CML UTxO mapping preserves output references and exact ADA amounts', () => {
  const utxoHex = makeUtxo().to_cbor_hex();

  assert.deepEqual(mapCborUtxos([utxoHex]), [
    {
      utxo_id: `${'11'.repeat(32)}3`,
      tx_hash: '11'.repeat(32),
      tx_index: '3',
      receiver: paymentAddress,
      amount: '20000000',
      assets: [],
    },
  ]);
});

test('CML transaction helper selects inputs, calculates fees and adds change', () => {
  const utxo = makeUtxo(0n);
  const address = CML.Address.from_bech32(paymentAddress);
  const built = buildSimpleTx(paymentAddress, '2000000', address.to_hex(), [utxo.to_cbor_hex()]);
  const transaction = CML.Transaction.from_cbor_hex(built.uTxHex);
  const outputs = transaction.body().outputs();

  assert.equal(transaction.body().inputs().len(), 1);
  assert.equal(transaction.body().fee().toString(), built.txFee);
  assert.ok(transaction.body().fee() > 0n);
  assert.equal(outputs.len(), 2);
  assert.equal(outputs.get(0).amount().coin(), 2000000n);
  assert.equal(outputs.get(1).address().to_bech32(), paymentAddress);
});

test('mock dApp CML transaction bytes stay stable for the frozen legacy fixture', () => {
  const stakeHash = CML.Ed25519KeyHash.from_raw_bytes(new Uint8Array(28).fill(1));
  const credential = CML.Credential.new_pub_key(stakeHash);
  const address = CML.BaseAddress.new(0, credential, credential).to_address();
  const utxoHex =
    '828258201111111111111111111111111111111111111111111111111111111111111111008258390001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101011a004c4b40';
  const result = buildSimpleTx(address.to_bech32(), '2000000', address.to_hex(), [utxoHex]);

  assert.equal(
    result.uTxHex,
    '84a300d901028182582011111111111111111111111111111111111111111111111111111111111111110001828258390001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101011a001e84808258390001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101011a002b3543021a0002917da0f5f6'
  );
});

test('CIP-95 key hashes are parsed as 28-byte hashes, not public keys', () => {
  const hashHex = '491112dd01155c07dab485f71b572e0cae759e2cd38b1c0e97554297';
  const hash = getKeyHashFromHex(hashHex);

  assert.equal(hash.to_hex(), hashHex);
});
