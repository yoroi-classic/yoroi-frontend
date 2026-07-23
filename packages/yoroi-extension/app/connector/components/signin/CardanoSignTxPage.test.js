import '../../../api/ada/lib/test-config.forTests';

import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import BigNumber from 'bignumber.js';
import { MultiToken } from '../../../api/common/lib/MultiToken';
import CardanoSignTxPage from './CardanoSignTxPage';

jest.mock('./cardano/SignTx', () => () => null);
jest.mock('./cardano/SignTxSummary', () => () => null);
jest.mock('./cardano/UtxoDetails', () => () => null);
jest.mock(
  '../../../containers/widgets/ExplorableHashContainer',
  () =>
    ({ children }) =>
      children
);
jest.mock('../../assets/images/external-link.inline.svg', () => ({ ReactComponent: () => null }));
jest.mock('../../../components/common/TextField', () => () => null);
jest.mock('../../../components/widgets/ErrorBlock', () => () => null);
jest.mock('../../../UI/features/connector/useCases/ConnectionInfo', () => () => null);
jest.mock(
  '../../../UI/features/connector/useCases/SignTxTabs',
  () =>
    ({ detailsContent }) =>
      detailsContent
);
jest.mock('@mui/material', () => {
  const React = require('react');
  return {
    Button: ({ children, disabled, id }) => React.createElement('button', { disabled, id, type: 'button' }, children),
    Typography: ({ children, id }) => React.createElement('div', { id }, children),
  };
});
jest.mock('@mui/system', () => {
  const React = require('react');
  return {
    Box: ({ children, id }) => React.createElement('div', { id }, children),
  };
});

const defaults = {
  defaultIdentifier: '',
  defaultNetworkId: 0,
};

function transactionData() {
  const amount = new MultiToken(
    [
      {
        amount: new BigNumber(0),
        identifier: defaults.defaultIdentifier,
        networkId: defaults.defaultNetworkId,
      },
    ],
    defaults
  );
  return {
    amount,
    total: amount,
    fee: {
      amount: '1',
      networkId: defaults.defaultNetworkId,
      tokenId: defaults.defaultIdentifier,
    },
    inputs: [],
    foreignInputs: [],
    outputs: [],
    cip95Info: [],
  };
}

test('renders one explicit approval for a navigable multi-transaction review', () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="en">
      <CardanoSignTxPage
        addressToDisplayString={value => value}
        connectedWebsite={null}
        defaultToken={defaults}
        getCurrentPrice={() => null}
        getTokenInfo={() => ({
          Identifier: '',
          IsDefault: true,
          Metadata: {
            type: 'Cardano',
            policyId: '',
            assetName: '',
            numberOfDecimals: 6,
            ticker: 'ADA',
            longName: null,
          },
        })}
        hwWalletError={null}
        isHwWalletErrorRecoverable={null}
        network={{}}
        notification={null}
        onCancel={() => {}}
        onConfirm={() => Promise.resolve()}
        onCopyAddressTooltip={() => {}}
        selectedExplorer={null}
        selectedWallet={{}}
        shouldHideBalance={false}
        signData={null}
        submissionError={null}
        tx=""
        txData={transactionData()}
        txDataBatch={[transactionData(), transactionData()]}
        txs={['tx-0', 'tx-1']}
        unitOfAccountSetting={{ enabled: false, currency: null }}
        walletType="mnemonic"
      />
    </IntlProvider>
  );

  expect(html).toContain('id="cip103BulkSignSummary"');
  expect(html).toContain('Review 2 transactions');
  expect(html).toContain('One approval will sign every transaction in this request, in the order shown.');
  expect(html).toContain('Transaction 1 of 2');
  expect(html).toContain('id="previousTransactionButton"');
  expect(html).toContain('id="nextTransactionButton"');
  expect(html).toContain('Sign 2 transactions');
  expect(html.match(/id="confirmButton"/g) || []).toHaveLength(1);
});
