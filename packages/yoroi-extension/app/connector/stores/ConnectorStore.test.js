import '../../api/ada/lib/test-config.forTests';

import BigNumber from 'bignumber.js';
import ConnectorStore, { addPriorBatchOutput } from './ConnectorStore';
import { MultiToken } from '../../api/common/lib/MultiToken';
import { loadSubmittedTransactions } from '../../api/localStorage';
import { multiTokenFromCardanoValue } from '../../api/ada/transactions/utils';

jest.mock('../../api/thunk', () => ({}));
jest.mock('../../api/localStorage', () => ({ loadSubmittedTransactions: jest.fn() }));
jest.mock('../../api/ada/transactions/utils', () => ({
  asAddressedUtxo: jest.fn(),
  multiTokenFromCardanoValue: jest.fn(),
  multiTokenFromRemote: jest.fn(),
}));
jest.mock('../../utils/hwConnectHandler', () => ({}));
jest.mock('../../stores/lib/TrezorWrapper', () => ({}));
jest.mock('../../api/ada/lib/cardanoCrypto/rustLoader', () => ({ RustModule: {} }));
jest.mock('../../../posthog', () => ({ captureEvent: jest.fn() }));

const defaults = { defaultIdentifier: '', defaultNetworkId: 0 };

const value = (ada, token = 0) =>
  new MultiToken(
    [
      { identifier: '', networkId: 0, amount: new BigNumber(ada) },
      { identifier: 'policy.asset', networkId: 0, amount: new BigNumber(token) },
    ],
    defaults
  );

const lenGet = values => ({
  len: () => values.length,
  get: index => values[index],
});

const createStoreForTransaction = ({ txBody, batchOutputs }) => {
  const ownAddress = 'owned-address';
  const connectedWallet = {
    networkId: 0,
    defaultTokenId: '',
    publicDeriverId: 1,
    utxos: [],
    allUtxoAddresses: [],
    allAddresses: {
      utxoAddresses: [{ address: { Hash: ownAddress } }],
      accountingAddresses: [],
    },
  };
  const stores = {
    tokenInfoStore: {
      tokenInfo: new Map([['0', new Map()]]),
      getDefaultTokenInfo: () => ({ Identifier: '', NetworkId: 0 }),
    },
  };
  const api = {
    localStorage: { getWhitelist: jest.fn(), setWhitelist: jest.fn() },
    ada: { _addressedUtxosWithSubmittedTxs: jest.fn().mockResolvedValue([]) },
  };
  const store = new ConnectorStore(stores, api);
  store.signingMessage = {
    tabId: 1,
    publicDeriverId: 1,
    sign: { type: 'txs/cardano', uid: 1, txs: [] },
  };
  store.wallets.replace([connectedWallet]);
  loadSubmittedTransactions.mockResolvedValue([]);
  multiTokenFromCardanoValue.mockReturnValue(value(98));

  return { batchOutputs, connectedWallet, store, txBody };
};

test('counts an owned chained output as an input in the transaction summary', async () => {
  const publicDeriver = {
    networkId: 0,
    defaultTokenId: '',
    allAddresses: { utxoAddresses: [], accountingAddresses: [] },
  };
  const ownAddresses = new Set(['owned-address']);
  const chainedInput = { address: 'owned-address', value: value(99, 1) };
  const output = { address: 'foreign-address', value: value(98, 0) };
  const inputs = [];
  const foreignInputDetails = [];

  addPriorBatchOutput(chainedInput, ownAddresses, inputs, foreignInputDetails);

  const { amount, total } = await ConnectorStore.prototype._calculateAmountAndTotal(
    publicDeriver,
    inputs,
    [output],
    { tokenId: '', networkId: 0, amount: '1' },
    [],
    ownAddresses
  );

  expect(foreignInputDetails).toHaveLength(0);
  expect(total.get('').toString()).toBe('-99');
  expect(total.get('policy.asset').toString()).toBe('-1');
  expect(amount.get('').toString()).toBe('-98');
});

test('includes an owned chained input when creating the transaction summary', async () => {
  const priorOutput = { address: 'owned-address', value: value(99, 1) };
  const txBody = {
    inputs: () =>
      lenGet([
        {
          transaction_id: () => ({ to_hex: () => 'prior-tx' }),
          index: () => 0,
        },
      ]),
    outputs: () =>
      lenGet([
        {
          address: () => ({ to_hex: () => 'foreign-address' }),
          amount: () => ({}),
        },
      ]),
    fee: () => ({ to_str: () => '1' }),
    certs: () => null,
    voting_procedures: () => null,
    voting_proposals: () => null,
    current_treasury_value: () => null,
    donation: () => null,
  };
  const batchOutputs = new Map([['prior-tx0', priorOutput]]);
  const { store } = createStoreForTransaction({ batchOutputs, txBody });
  const transaction = {
    body: () => txBody,
  };
  const { RustModule } = require('../../api/ada/lib/cardanoCrypto/rustLoader');
  RustModule.WalletV4 = {
    FixedTransaction: { from_hex: () => transaction },
  };

  await store.createAdaTransaction({ tx: 'transaction', partialSign: false }, 0, batchOutputs);

  expect(store.adaTransaction.inputs).toEqual([priorOutput]);
  expect(store.adaTransaction.foreignInputs).toEqual([]);
  expect(store.adaTransaction.total.get('').toString()).toBe('-99');
  expect(store.adaTransaction.total.get('policy.asset').toString()).toBe('-1');
  expect(store.adaTransaction.amount.get('').toString()).toBe('-98');
  expect(store.adaTransaction.amount.get('policy.asset').toString()).toBe('-1');
});

test('labels a chained output to a foreign address as foreign', () => {
  const inputs = [];
  const foreignInputDetails = [];
  addPriorBatchOutput({ address: 'foreign-address', value: value(1) }, new Set(['owned-address']), inputs, foreignInputDetails);

  expect(inputs).toHaveLength(0);
  expect(foreignInputDetails).toHaveLength(1);
});
