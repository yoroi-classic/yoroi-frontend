import '../../../api/ada/lib/test-config.forTests';

import BigNumber from 'bignumber.js';
import ConnectorStore, { addPriorBatchOutput } from './ConnectorStore';
import { MultiToken } from '../../../api/common/lib/MultiToken';

const defaults = { defaultIdentifier: '', defaultNetworkId: 0 };

const value = (ada, token = 0) =>
  new MultiToken(
    [
      { identifier: '', networkId: 0, amount: new BigNumber(ada) },
      { identifier: 'policy.asset', networkId: 0, amount: new BigNumber(token) },
    ],
    defaults
  );

test('counts an owned chained output as an input in the transaction summary', async () => {
  const publicDeriver = {
    networkId: 0,
    defaultTokenId: '',
    allAddresses: { utxoAddresses: [], accountingAddresses: [] },
  };
  const ownAddresses = new Set(['owned-address']);
  const chainedInput = { address: 'owned-address', value: value(99, 1) };
  const output = { address: 'foreign-address', value: value(98, 0) };

  const { amount, total } = await ConnectorStore.prototype._calculateAmountAndTotal(
    publicDeriver,
    [chainedInput],
    [output],
    { tokenId: '', networkId: 0, amount: '1' },
    [],
    ownAddresses
  );

  expect(total.get('').toString()).toBe('-99');
  expect(total.get('policy.asset').toString()).toBe('-1');
  expect(amount.get('').toString()).toBe('-98');
});

test('labels a chained output to a foreign address as foreign', () => {
  const inputs = [];
  const foreignInputDetails = [];
  addPriorBatchOutput(
    { address: 'foreign-address', value: value(1) },
    new Set(['owned-address']),
    inputs,
    foreignInputDetails
  );

  expect(inputs).toHaveLength(0);
  expect(foreignInputDetails).toHaveLength(1);
});
