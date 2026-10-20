// @flow

import '../test-config.forTests';
import { RustModule } from '../cardanoCrypto/rustLoader';

import { batchGetTransactionsHistoryForAddresses } from './batchedFetcher';
import { genGetTransactionsHistoryForAddresses } from './mockNetwork.forTests';
import { generateWalletRootKey } from '../cardanoCrypto/cryptoWallet';
import { HARD_DERIVATION_START, WalletTypePurpose, CoinTypes, ChainDerivations } from '../../../../config/numbersConfig';
import type { ConfigType } from '../../../../../config/config-types';
import config from '../../../../config';
import { networks } from '../storage/database/prepackaged/networks';

// populated by ConfigWebpackPlugin
declare var CONFIG: ConfigType;

const network = networks.CardanoMainnet;

beforeAll(async () => {
  await RustModule.load();
});

function generateAddresses(count: number): Array<string> {
  const rootKeyBytes = generateWalletRootKey(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon share'
  ).to_raw_bytes();
  const byronNetworkId = network.BaseConfig[0].ByronNetworkId;
  if (byronNetworkId == null) throw new Error('missing Byron network id');
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const chainKey = cml.Bip32PrivateKey.from_raw_bytes(rootKeyBytes)
      .derive(WalletTypePurpose.BIP44)
      .derive(CoinTypes.CARDANO)
      .derive(HARD_DERIVATION_START)
      .derive(ChainDerivations.EXTERNAL);
    return Array.from({ length: count }, (_, index) =>
      cml.AddressContent.icarus_from_key(
        chainKey.derive(index).to_public(),
        cml.ProtocolMagic.new(Number(byronNetworkId))
      ).to_address().to_base58()
    );
  });
}

test('Batched history pagination', async done => {
  // We want to make sure both batching on addresses and transactions is executed
  const numIterations = Math.max(CONFIG.app.addressRequestSize, config.wallets.TRANSACTION_REQUEST_SIZE) * 2 + 1;
  const addresses = generateAddresses(numIterations);

  const transactions = [];
  for (let i = 0; i < numIterations; i++) {
    const genesisBlockHash = '0';
    transactions.push({
      hash: (i + 1).toString(),
      inputs: [
        {
          address: addresses[0],
          txHash: genesisBlockHash,
          id: genesisBlockHash + i.toString(),
          index: i,
          amount: '1000000',
          assets: [],
        },
      ],
      outputs: [
        {
          address: addresses[i],
          amount: '1',
          assets: [],
        },
      ],
      height: i,
      epoch: 0,
      slot: i,
      tx_ordinal: 0,
      block_hash: i.toString(),
      time: new Date(i).toString(),
      last_update: new Date(i).toString(),
      tx_state: 'Successful',
    });
  }

  const getTransactionsHistoryForAddresses = await batchGetTransactionsHistoryForAddresses(
    genGetTransactionsHistoryForAddresses(transactions, network)
  );
  const result = await getTransactionsHistoryForAddresses({
    network,
    addresses,
    untilBlock: transactions[transactions.length - 1].block_hash || '',
  });

  expect(result.length).toEqual(numIterations);
  done();
});

test('Batched history edge case: full response with a pending transaction', async done => {
  const addresses = generateAddresses(config.wallets.TRANSACTION_REQUEST_SIZE);

  const transactions = [];
  const genesisBlockHash = '0'; // fake hash just for the test

  // fill response with in-block transactions except for one
  for (let i = 0; i < config.wallets.TRANSACTION_REQUEST_SIZE - 1; i++) {
    transactions.push({
      hash: (i + 1).toString(),
      inputs: [
        {
          address: addresses[0],
          txHash: genesisBlockHash,
          id: genesisBlockHash + i.toString(),
          index: i,
          amount: '1000000',
          assets: [],
        },
      ],
      outputs: [
        {
          address: addresses[i],
          amount: '1',
          assets: [],
        },
      ],
      height: i,
      epoch: 0,
      slot: i,
      tx_ordinal: 0,
      block_hash: i.toString(),
      time: new Date(i).toString(),
      last_update: new Date(i).toString(),
      tx_state: 'Successful',
    });
  }
  // last tx in response is a pending transaction
  {
    const i = config.wallets.TRANSACTION_REQUEST_SIZE - 1;
    transactions.push({
      hash: (i + 1).toString(),
      inputs: [
        {
          address: addresses[0],
          txHash: genesisBlockHash,
          id: genesisBlockHash + i.toString(),
          index: i,
          amount: '1000000',
          assets: [],
        },
      ],
      outputs: [
        {
          address: addresses[i],
          amount: '1',
          assets: [],
        },
      ],
      height: null,
      epoch: null,
      slot: null,
      tx_ordinal: null,
      block_hash: null,
      time: null,
      last_update: new Date(i).toString(),
      tx_state: 'Pending',
    });
  }

  const getTransactionsHistoryForAddresses = await batchGetTransactionsHistoryForAddresses(
    genGetTransactionsHistoryForAddresses(transactions, network)
  );
  const result = await getTransactionsHistoryForAddresses({
    network,
    addresses,
    untilBlock: transactions.filter(tx => tx.block_hash != null).slice(-1)[0].block_hash || '',
  });

  expect(result.length).toEqual(config.wallets.TRANSACTION_REQUEST_SIZE);
  done();
});
