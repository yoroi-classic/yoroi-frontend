import { getConnectedSite, getConnectedWallet, setConnectedSite } from '../content/connect';
import { sendToInjector } from '../content/utils';
import { TxSignErrorCodes } from '../../../connector/types';
import { UserSignConfirm } from './connector';

jest.mock('../content/connect', () => ({
  connectContinuation: jest.fn(),
  deleteConnectedSite: jest.fn(),
  getAllConnectedSites: jest.fn(),
  getConnectedSite: jest.fn(),
  getConnectedWallet: jest.fn(),
  setConnectedSite: jest.fn(),
}));
jest.mock('../content/utils', () => ({ sendToInjector: jest.fn() }));
jest.mock('./utils', () => ({ getPublicDeriverById: jest.fn() }));
jest.mock('../../../../../app/api/ada/lib/storage/models/PublicDeriver/traits', () => ({
  asGetPublicKey: jest.fn(),
}));
jest.mock('../../../connector/api', () => {
  class ConnectorBatchSignError extends Error {}
  return {
    ConnectorBatchSignError,
    connectorSignCardanoTx: jest.fn(),
    connectorSignCardanoTxs: jest.fn(),
    transformCardanoUtxos: jest.fn(),
  };
});
jest.mock('../../../connector/types', () => ({
  DataSignErrorCodes: {
    DATA_SIGN_PROOF_GENERATION: 1,
    DATA_SIGN_USER_DECLINED: 3,
  },
  TxSignErrorCodes: {
    PROOF_GENERATION: 1,
    USER_DECLINED: 2,
  },
}));
jest.mock('../../../../../app/connector/api', () => ({ createAuthEntry: jest.fn() }));
jest.mock('../../../../../app/api/export/utils', () => ({ getWalletChecksum: jest.fn() }));
jest.mock('../../../../../app/api/ada/lib/cardanoCrypto/rustLoader', () => ({ RustModule: {} }));
jest.mock('../../../../../app/coreUtils', () => ({ hexToBytes: jest.fn() }));
jest.mock('../../../../../app/utils/logging', () => ({ Logger: { error: jest.fn() } }));
jest.mock('../../../../../app/api/ada', () => ({
  encodeHardwareWalletSignResult: jest.fn(),
  walletSignData: jest.fn(),
}));
jest.mock('../../../../../app/api/ada/lib/cardanoCrypto/utils', () => ({
  transactionHexAddSignaturesFromWitnessSetHex: jest.fn(),
  transactionHexToWitnessSet: jest.fn(),
}));

test('returns a proof-generation error when hardware bulk signing omits witness sets', async () => {
  const connection = {
    pendingSigns: {
      '7': {
        continuationData: { type: 'cardano-txs' },
        request: {
          type: 'txs/cardano',
          txs: [{ tx: 'tx-0', partialSign: false, returnTx: false }],
          uid: 7,
        },
      },
    },
  };
  getConnectedSite.mockResolvedValue(connection);
  getConnectedWallet.mockResolvedValue({});

  await UserSignConfirm.handle({
    password: '',
    tabId: 44,
    tx: null,
    uid: 7,
  });

  expect(sendToInjector).toHaveBeenCalledWith(44, {
    type: 'connector_rpc_response',
    uid: 7,
    return: {
      err: {
        code: TxSignErrorCodes.PROOF_GENERATION,
        info: 'Missing witness sets from connector dialog',
      },
    },
    protocol: 'cardano',
  });
  expect(connection.pendingSigns['7']).toBeUndefined();
  expect(setConnectedSite).toHaveBeenCalledWith(44, connection);
});
