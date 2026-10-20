import assert from 'node:assert/strict';
import test from 'node:test';
import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs';
import { buildSimpleTx } from './dAppHelper.js';
import {
  addressesFromCborIfNeeded,
  getAmountInHex,
  getDRepIDHexAndBechFromHex,
  getPublicKeyHash,
  getRewardKeyHashFromBech32,
  mapCborUtxos,
} from './dAppTxHelper.js';

const stakeHash = CML.Ed25519KeyHash.from_raw_bytes(new Uint8Array(28).fill(1));
const credential = CML.Credential.new_pub_key(stakeHash);
const address = CML.BaseAddress.new(0, credential, credential).to_address();
const utxoHex = '828258201111111111111111111111111111111111111111111111111111111111111111008258390001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101011a004c4b40';

test('CML helpers preserve CIP-30 address, value, and UTxO representations', () => {
  assert.equal(getAmountInHex('2000000'), '1a001e8480');
  assert.deepEqual(addressesFromCborIfNeeded([address.to_hex()]), [address.to_bech32()]);
  assert.equal(getRewardKeyHashFromBech32(CML.RewardAddress.new(0, credential).to_address().to_bech32()), stakeHash.to_hex());
  assert.deepEqual(mapCborUtxos([utxoHex]), [{
    utxo_id: `${'11'.repeat(32)}0`,
    tx_hash: '11'.repeat(32),
    tx_index: 0,
    receiver: address.to_bech32(),
    amount: '5000000',
    assets: [],
  }]);
});

test('CML mock dApp transaction builder matches the frozen legacy transaction bytes', () => {
  const result = buildSimpleTx(address.to_bech32(), '2000000', address.to_hex(), [utxoHex]);
  const transaction = CML.Transaction.from_cbor_hex(result.uTxHex);
  const body = transaction.body();
  const outputs = body.outputs();

  assert.equal(transaction.is_valid(), true);
  assert.equal(body.inputs().len(), 1);
  assert.equal(body.fee().toString(), result.txFee);
  assert.equal(result.txFee, '168317');
  assert.equal(
    result.uTxHex,
    '84a300d901028182582011111111111111111111111111111111111111111111111111111111111111110001828258390001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101011a001e84808258390001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101011a002b3543021a0002917da0f5f6'
  );
  assert.equal(outputs.len(), 2);
  assert.equal(outputs.get(0).amount().coin(), 2000000n);
  assert.equal(outputs.get(1).amount().coin(), 2831683n);
  assert.equal(outputs.get(0).address().to_bech32(), address.to_bech32());
  assert.equal(outputs.get(1).address().to_bech32(), address.to_bech32());
});

test('public-key and DRep hashes retain their hex and bech32 forms', () => {
  const publicKey = new Uint8Array(32).fill(7);
  const keyHash = getPublicKeyHash(Buffer.from(publicKey).toString('hex'));
  const drep = getDRepIDHexAndBechFromHex(Buffer.from(publicKey).toString('hex'));

  assert.equal(drep.dRepIDHex, keyHash.to_hex());
  assert.equal(drep.dRepIDBech32, keyHash.to_bech32('drep'));
});

test('multiasset UTxOs preserve policy, asset-name bytes, and integer quantity', () => {
  const policy = CML.ScriptHash.from_raw_bytes(new Uint8Array(28).fill(2));
  const assetName = CML.AssetName.from_raw_bytes(Buffer.from('TOKEN', 'utf8'));
  const multiAsset = CML.MultiAsset.new();
  multiAsset.set(policy, assetName, 7n);
  const value = CML.Value.new(4000000n, multiAsset);
  const input = CML.TransactionInput.new(CML.TransactionHash.from_hex('22'.repeat(32)), 3n);
  const output = CML.TransactionOutput.new(address, value);
  const utxoHex = CML.TransactionUnspentOutput.new(input, output).to_cbor_hex();

  assert.deepEqual(mapCborUtxos([utxoHex])[0].assets, [{
    policyId: policy.to_hex(),
    name: Buffer.from('TOKEN', 'utf8').toString('hex'),
    amount: '7',
    assetId: `${policy.to_hex()}.${Buffer.from('TOKEN', 'utf8').toString('hex')}`,
  }]);
  assert.equal(CML.Value.from_cbor_hex(value.to_cbor_hex()).multi_asset().get(policy, assetName), 7n);
});
