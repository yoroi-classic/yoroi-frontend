// @flow
import '../../api/ada/lib/test-config.forTests';

import { schema } from 'lovefield';
import BigNumber from 'bignumber.js';
import AdaApi from '../../api/ada';
import { loadLovefieldDB } from '../../api/ada/lib/storage/database';
import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';
import { bytesToHex } from '../../coreUtils';
import { getProtocolParameters } from '../../api/thunk';
import { networks } from '../../api/ada/lib/storage/database/prepackaged/networks';
import { HARD_DERIVATION_START } from '../../config/numbersConfig';
import { asGetAllUtxos } from '../../api/ada/lib/storage/models/PublicDeriver/traits';
import SwapStore from './SwapStore';

jest.mock('../../api/thunk', () => ({
  broadcastTransaction: jest.fn(),
  getProtocolParameters: jest.fn(),
}));
jest.mock('../../assets/images/ada.inline.svg', () => 'ada-logo');

let db;
const mockedGetProtocolParameters: any = getProtocolParameters;

const recoveryPhrase = 'prevent company field green slot measure chief hero apple task eagle sunset endorse dress seed';

beforeAll(async () => {
  await RustModule.load();
  db = await loadLovefieldDB(schema.DataStoreType.MEMORY);
});

test('preserves swap datum bytes through sign request and transaction submission', async () => {
  mockedGetProtocolParameters.mockResolvedValue({
    keyDeposit: '2000000',
    poolDeposit: '500000000',
  });
  const restored = await AdaApi.prototype.restoreWallet({
    db,
    recoveryPhrase,
    walletName: 'swap-datum-test',
    walletPassword: '123',
    network: networks.CardanoMainnet,
    accountIndex: HARD_DERIVATION_START,
  });
  const withUtxos = asGetAllUtxos(restored.publicDerivers[0]);
  if (withUtxos == null) throw new Error('Restored wallet is missing UTxO support');
  const [addressPath] = await withUtxos.getAllUtxoAddresses();
  const address = addressPath?.addrs[0];
  if (address == null) throw new Error('Restored wallet has no UTxO address');
  const inputHash = '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f';
  const witnessSetBytes = Uint8Array.from([0xa1, 0x04, 0x9f, 0x01, 0xff]);
  const { fullTransactionHex, expectedScriptDataHash } = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const bodyInputs = cml.TransactionInputList.new();
    bodyInputs.add(cml.TransactionInput.new(cml.TransactionHash.from_hex(inputHash), BigInt('0')));
    const bodyOutputs = cml.TransactionOutputList.new();
    bodyOutputs.add(
      cml.TransactionOutput.new(cml.Address.from_hex(address.Hash), cml.Value.new(BigInt('2000000'), cml.MultiAsset.new()))
    );
    const body = cml.TransactionBody.new(bodyInputs, bodyOutputs, BigInt('1000'));
    const existingWitnesses = cml.TransactionWitnessSet.from_cbor_bytes(witnessSetBytes);
    const scriptDataHash = cml.hash_script_data(
      cml.Redeemers.from_cbor_hex('80'),
      cml.CostModels.from_cbor_hex('a0'),
      existingWitnesses.plutus_datums()
    );
    body.set_script_data_hash(scriptDataHash);

    const bodyBytes = body.to_cbor_bytes();
    const auxiliaryDataBytes = Uint8Array.from([0xf6]);
    const fullTransaction = new Uint8Array(1 + bodyBytes.length + witnessSetBytes.length + 1 + auxiliaryDataBytes.length);
    let offset = 0;
    fullTransaction[offset++] = 0x84;
    fullTransaction.set(bodyBytes, offset);
    offset += bodyBytes.length;
    fullTransaction.set(witnessSetBytes, offset);
    offset += witnessSetBytes.length;
    fullTransaction[offset++] = 0xf5;
    fullTransaction.set(auxiliaryDataBytes, offset);
    return {
      fullTransactionHex: bytesToHex(fullTransaction),
      expectedScriptDataHash: scriptDataHash.to_hex(),
    };
  });

  const wallet = {
    networkId: networks.CardanoMainnet.NetworkId,
    utxos: [
      {
        output: {
          Transaction: { Hash: inputHash },
          UtxoTransactionOutput: { OutputIndex: 0 },
        },
        address: address.Hash,
        addressing: addressPath.addressing,
      },
    ],
  };
  const swapStore = new (SwapStore: any)({}, {});
  const signRequest = await swapStore.createRevampUnsignedSwapTx({
    wallet,
    swapState: { createTx: { cbor: fullTransactionHex } },
  });
  expect(signRequest.senderUtxos).toHaveLength(1);
  expect(bytesToHex(signRequest.witnessSet)).toBe('a1049f01ff');
  const submittedTransactions = [];
  const result = await AdaApi.prototype.signAndBroadcast({
    publicDeriver: restored.publicDerivers[0],
    signRequest,
    password: '123',
    sendTx: async ({ encodedTx }) => {
      submittedTransactions.push(encodedTx);
      return { txId: 'test-transaction-id' };
    },
  });

  expect(submittedTransactions).toHaveLength(1);
  expect(result.txId).toBe('test-transaction-id');
  expect(result.signedTxHex).toBe(bytesToHex(submittedTransactions[0]));
  expect(
    RustModule.WasmScope(Module => {
      const transaction = Module.CML.Transaction.from_cbor_bytes(submittedTransactions[0]);
      return {
        witnessSetHex: transaction.witness_set().to_cbor_hex(),
        scriptDataHash: transaction.body().script_data_hash()?.to_hex(),
      };
    })
  ).toMatchObject({ scriptDataHash: expectedScriptDataHash });
  const signedWitnessSetHex = RustModule.WasmScope(Module =>
    Module.CML.Transaction.from_cbor_bytes(submittedTransactions[0]).witness_set().to_cbor_hex()
  );
  expect(signedWitnessSetHex.endsWith('049f01ff')).toBe(true);
  expect(signRequest.networkSettingSnapshot.KeyDeposit).toEqual(new BigNumber('2000000'));
});
