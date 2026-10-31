// @flow
import '../../../../../app/api/ada/lib/test-config.forTests';

import AdaApi from '../../../../../app/api/ada';
import { RustModule } from '../../../../../app/api/ada/lib/cardanoCrypto/rustLoader';
import { SignAndBroadcastTransaction } from './transaction';
import { getPublicDeriverById } from './utils';
import { connectorRecordSubmittedCardanoTransaction } from '../../../connector/api';
import { emitUpdateToSubscriptions } from '../../subscriptionManager';
import { getCardanoStateFetcher } from '../../utils';

jest.mock('./utils', () => ({ getPublicDeriverById: jest.fn() }));
jest.mock('../../../connector/api', () => ({
  connectorRecordSubmittedCardanoTransaction: jest.fn(),
  connectorSignCardanoTx: jest.fn(),
}));
jest.mock('../../subscriptionManager', () => ({
  emitUpdateToSubscriptions: jest.fn(),
  registerCallback: jest.fn(),
}));
jest.mock('../../utils', () => ({ getCardanoStateFetcher: jest.fn() }));
jest.mock('../utils', () => ({ getWalletsState: jest.fn().mockResolvedValue([{}]) }));

const mockedGetPublicDeriverById: any = getPublicDeriverById;
const mockedGetCardanoStateFetcher: any = getCardanoStateFetcher;
const mockedRecordSubmitted: any = connectorRecordSubmittedCardanoTransaction;
const mockedEmitUpdate: any = emitUpdateToSubscriptions;
let signAndBroadcastTransaction;

beforeAll(async () => {
  await RustModule.load();
  global.chrome = { storage: { session: {} }, runtime: { onMessage: { addListener: jest.fn() } } };
  Object.defineProperty(window, 'chrome', { configurable: true, value: global.chrome });
  signAndBroadcastTransaction = require('../../../../../app/api/thunk').signAndBroadcastTransaction;
});

test('preserves a swap witness set from thunk serialization through the background handler', async () => {
  mockedGetPublicDeriverById.mockResolvedValue({});
  mockedGetCardanoStateFetcher.mockResolvedValue({ sendTx: jest.fn() });
  mockedRecordSubmitted.mockResolvedValue(undefined);
  mockedEmitUpdate.mockResolvedValue(undefined);

  const { emptyWitnessTransactionHex, transactionBodyBytes, swapWitnessSetBytes } = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const address = cml.EnterpriseAddress.new(
      1,
      cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)))
    ).to_address();
    const inputs = cml.TransactionInputList.new();
    inputs.add(
      cml.TransactionInput.new(
        cml.TransactionHash.from_hex('05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f'),
        BigInt('0')
      )
    );
    const outputs = cml.TransactionOutputList.new();
    outputs.add(cml.TransactionOutput.new(address, cml.Value.new(BigInt('2000000'), cml.MultiAsset.new())));
    const body = cml.TransactionBody.new(inputs, outputs, BigInt('1000'));
    const bodyBytes = body.to_cbor_bytes();
    const witnessSetBytes = Uint8Array.from([0xa1, 0x04, 0x9f, 0x01, 0xff]);
    return {
      emptyWitnessTransactionHex: cml.Transaction.new(body, cml.TransactionWitnessSet.new(), true).to_cbor_hex(),
      transactionBodyBytes: bodyBytes,
      swapWitnessSetBytes: witnessSetBytes,
    };
  });
  let forwardedSignRequest;
  jest.spyOn(AdaApi.prototype, 'signAndBroadcast').mockImplementation(async request => {
    forwardedSignRequest = request.signRequest;
    return { txId: 'swap-tx-id', signedTxHex: '00' };
  });

  const runtime = {
    lastError: null,
    sendMessage: (message, callback) => {
      return SignAndBroadcastTransaction.handle(JSON.parse(message.request)).then(callback);
    },
  };
  Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime } });

  const result = await signAndBroadcastTransaction({
    signRequest: {
      senderUtxos: [],
      unsignedTx: transactionBodyBytes,
      witnessSet: swapWitnessSetBytes,
      metadata: undefined,
      serializedUnsignedTxHex: () => emptyWitnessTransactionHex,
    },
    password: 'test-password',
    publicDeriverId: 1,
  });

  expect(result).toEqual({ txId: 'swap-tx-id' });
  expect(forwardedSignRequest.witnessSet).toEqual(swapWitnessSetBytes);
});
