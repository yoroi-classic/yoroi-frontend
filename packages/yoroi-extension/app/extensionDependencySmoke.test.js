// @flow
import './api/ada/lib/test-config.forTests';

import fs from 'fs';
import path from 'path';
import BigNumber from 'bignumber.js';
import WalletRestoreStore, { RestoreSteps } from './stores/toplevel/WalletRestoreStore';
import AdaStateFetchStore from './stores/ada/AdaStateFetchStore';
import { RemoteFetcher as AdaRemoteFetcher } from './api/ada/lib/state-fetch/remoteFetcher';
import { defaultAssets, networks } from './api/ada/lib/storage/database/prepackaged/networks';
import { RustModule } from './api/ada/lib/cardanoCrypto/rustLoader';
import { MultiToken } from './api/common/lib/MultiToken';
import { byronAddrToHex } from './api/ada/lib/storage/bridge/utils';
import { Bip44DerivationLevels } from './api/ada/lib/storage/database/walletTypes/bip44/api/utils';
import { newAdaUnsignedTx, signTransaction } from './api/ada/transactions/shelley/transactions';

import mainnetConfig from '../config/mainnet.json';
import shelleyTestnetConfig from '../config/shelley-testnet.json';
import developmentConfig from '../config/development.json';
import testConfig from '../config/test.json';

const SMOKE_MNEMONIC = 'prevent company field green slot measure chief hero apple task eagle sunset endorse dress seed';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

const EXPECTED_DIRECT_EMURGO_DEPENDENCIES = [
  'packages/e2e-tests:devDependencies:@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:dependencies:@emurgo/bringweb3-chrome-extension-kit',
  'packages/yoroi-extension:dependencies:@emurgo/cardano-message-signing-browser',
  'packages/yoroi-extension:dependencies:@emurgo/cardano-serialization-lib-browser',
  'packages/yoroi-extension:dependencies:@emurgo/cross-csl-browser',
  'packages/yoroi-extension:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:dependencies:@emurgo/yoroi-eutxo-txs',
  'packages/yoroi-extension:dependencies:@emurgo/yoroi-lib',
  'packages/yoroi-extension:devDependencies:@emurgo/cardano-message-signing-nodejs',
  'packages/yoroi-extension:devDependencies:@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:devDependencies:@emurgo/cross-csl-nodejs',
];

const EXPECTED_TRANSITIVE_EMURGO_DEPENDENCY_EDGES = [
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-browser:dependencies:@emurgo/cardano-serialization-lib-browser',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-browser:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-nodejs:dependencies:@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-nodejs:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@emurgo/yoroi-eutxo-txs:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@emurgo/yoroi-lib:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@fivebinaries/coin-selection:dependencies:@emurgo/cardano-serialization-lib-browser',
  'packages/yoroi-extension:node_modules/@fivebinaries/coin-selection:dependencies:@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:node_modules/@yoroi/api:dependencies:@emurgo/cip14-js',
  'packages/yoroi-extension:node_modules/@yoroi/staking:dependencies:@emurgo/cip14-js',
  'packages/yoroi-extension:node_modules/legacySwap/node_modules/@yoroi/api:dependencies:@emurgo/cip14-js',
  'packages/yoroi-extension:node_modules/legacySwap:dependencies:@emurgo/cip14-js',
];

const CARDANO_MAINNET = networks.CardanoMainnet;
const DEFAULT_TOKEN = defaultAssets.find(asset => asset.NetworkId === CARDANO_MAINNET.NetworkId);
if (DEFAULT_TOKEN == null) throw new Error('Missing Cardano mainnet default token fixture');

const DEFAULT_TOKEN_CONTEXT = {
  defaultIdentifier: DEFAULT_TOKEN.Identifier,
  defaultNetworkId: CARDANO_MAINNET.NetworkId,
};

function protocolParams() {
  return {
    linearFeeCoefficient: '2',
    linearFeeConstant: '500',
    coinsPerUtxoByte: '1',
    poolDeposit: '500',
    keyDeposit: '500',
    networkId: Number(CARDANO_MAINNET.BaseConfig[0].ChainNetworkId),
  };
}

function backendNetwork() {
  return {
    ...CARDANO_MAINNET,
    Backend: {
      ...CARDANO_MAINNET.Backend,
      BackendService: 'http://localhost:18082',
    },
  };
}

function successfulJsonResponse(body) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

function installCardanoApiForTest() {
  const originalPostMessage = window.postMessage;
  window.postMessage = jest.fn();
  delete (window: any).CardanoAPI;
  jest.isolateModules(() => {
    require('../chrome/content-scripts/cardanoApiInject.js');
  });
  window.postMessage = originalPostMessage;
  return (window: any).CardanoAPI;
}

function readPackageJson(packagePath) {
  return JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, packagePath, 'package.json'), 'utf8'));
}

function readPackageLock(packagePath) {
  return JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, packagePath, 'package-lock.json'), 'utf8'));
}

function directEmurgoDependencies(packagePath) {
  const packageJson = readPackageJson(packagePath);
  const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

  return dependencyFields.flatMap(field =>
    Object.keys(packageJson[field] || {})
      .filter(dependencyName => dependencyName.startsWith('@emurgo/'))
      .map(dependencyName => `${packagePath}:${field}:${dependencyName}`)
  );
}

function transitiveEmurgoDependencyEdges(packagePath) {
  const packageLock = readPackageLock(packagePath);
  const packageLockEntries: { [string]: any } = packageLock.packages || {};

  return Object.entries(packageLockEntries).flatMap(([packageEntry, packageMetadata]) => {
    if (packageEntry === '') return [];

    const packageMetadataObject: any = packageMetadata;
    const dependencies: { [string]: any } = (packageMetadataObject && packageMetadataObject.dependencies) || {};

    return Object.keys(dependencies)
      .filter(dependencyName => dependencyName.startsWith('@emurgo/'))
      .map(dependencyName => `${packagePath}:${packageEntry}:dependencies:${dependencyName}`);
  });
}

const originalFetch = (global: any).fetch;
const originalAbortSignalTimeout = (AbortSignal: any).timeout;

afterEach(() => {
  (global: any).fetch = originalFetch;
  if (originalAbortSignalTimeout === undefined) {
    delete (AbortSignal: any).timeout;
  } else {
    (AbortSignal: any).timeout = originalAbortSignalTimeout;
  }
  jest.restoreAllMocks();
});

describe('extension dependency smoke', () => {
  beforeAll(async () => {
    await RustModule.load();
  });

  test('keeps direct EMURGO package dependencies inside the migration inventory', () => {
    const directDependencies = [
      ...directEmurgoDependencies('packages/yoroi-extension'),
      ...directEmurgoDependencies('packages/e2e-tests'),
    ].sort();

    expect(directDependencies).toEqual(EXPECTED_DIRECT_EMURGO_DEPENDENCIES);
  });

  test('keeps transitive EMURGO lockfile edges inside the migration inventory', () => {
    const transitiveDependencies = [
      ...transitiveEmurgoDependencyEdges('packages/yoroi-extension'),
      ...transitiveEmurgoDependencyEdges('packages/e2e-tests'),
    ].sort();

    expect(transitiveDependencies).toEqual(EXPECTED_TRANSITIVE_EMURGO_DEPENDENCY_EDGES);
  });

  test('initializes restore and sync-facing stores', () => {
    const restoreStore = new WalletRestoreStore(({}: any), ({}: any));
    restoreStore.initialize();

    expect(restoreStore.step).toEqual(RestoreSteps.START);
    expect(
      restoreStore.isValidMnemonic({
        mnemonic: SMOKE_MNEMONIC,
        mode: ({
          type: 'cip1852',
          extra: undefined,
          length: 15,
        }: any),
      })
    ).toEqual(true);

    const stateFetchStore = new AdaStateFetchStore(
      ({
        profile: {
          currentLocale: 'en-US',
        },
      }: any),
      ({}: any)
    );
    stateFetchStore.initialize();

    expect(stateFetchStore.fetcher).toEqual(
      expect.objectContaining({
        getBestBlock: expect.any(Function),
        getTransactionsHistoryForAddresses: expect.any(Function),
        getUTXOsForAddresses: expect.any(Function),
      })
    );
  });

  test('normalizes mocked backend transaction history responses', async () => {
    const bech32Address =
      'addr1q8gpjmyy8zk9nuza24a0f4e7mgp9gd6h3uayp0rqnjnkl54v4dlyj0kwfs0x4e38a7047lymzp37tx0y42glslcdtzhqphf76y';
    const fetchFixture = [
      {
        type: 'shelley',
        hash: 'tx-hash',
        last_update: '2024-01-01T00:00:00.000Z',
        tx_state: 'Successful',
        inputs: [
          {
            id: 'input-id',
            index: 0,
            txHash: 'parent-hash',
            address: bech32Address,
            amount: '1000000',
          },
        ],
        outputs: [
          {
            address: bech32Address,
            amount: '900000',
          },
        ],
        fee: '100000',
        certificates: [],
        withdrawals: [],
        metadata: null,
        block_num: 42,
        block_hash: 'block-hash',
        tx_ordinal: 0,
        time: '2024-01-01T00:00:00.000Z',
        epoch: 1,
        slot: 2,
      },
    ];
    (global: any).fetch = jest.fn(() => successfulJsonResponse(fetchFixture));
    (AbortSignal: any).timeout = jest.fn(() => new AbortController().signal);

    const fetcher = new AdaRemoteFetcher(
      () => '5.23.200',
      () => 'en-US',
      () => 'chrome'
    );
    const history = await fetcher.getTransactionsHistoryForAddresses({
      network: backendNetwork(),
      addresses: ['addr_fixture'],
      untilBlock: 'block-hash',
    });

    expect((global: any).fetch).toHaveBeenCalledWith(
      'http://localhost:18082/api/v2/txs/history',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          addresses: ['addr_fixture'],
          untilBlock: 'block-hash',
        }),
        headers: {
          'content-type': 'application/json',
          'yoroi-version': '5.23.200',
          'yoroi-locale': 'en-US',
        },
      })
    );
    const normalizedTx = (history[0]: any);
    expect(normalizedTx.height).toEqual(42);
    expect(normalizedTx.block_num).toEqual(undefined);
    expect(history[0].inputs[0].assets).toEqual([]);
    expect(history[0].outputs[0].assets).toEqual([]);
    expect(history[0].inputs[0].address).not.toEqual(bech32Address);
    expect(history[0].outputs[0].address).not.toEqual(bech32Address);
  });

  test('keeps the legacy best block endpoint by default', async () => {
    const fetchFixture = {
      height: 3500000,
      epoch: 199,
      slot: 86400123,
      hash: 'aa11bb22',
    };
    (global: any).fetch = jest.fn(() => successfulJsonResponse(fetchFixture));
    (AbortSignal: any).timeout = jest.fn(() => new AbortController().signal);

    const fetcher = new AdaRemoteFetcher(
      () => '5.23.200',
      () => 'en-US',
      () => 'chrome'
    );
    const bestBlock = await fetcher.getBestBlock({
      network: backendNetwork(),
    });

    expect((global: any).fetch).toHaveBeenCalledWith(
      'http://localhost:18082/api/v2/bestblock',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'yoroi-version': '5.23.200',
          'yoroi-locale': 'en-US',
        },
      })
    );
    expect(bestBlock).toEqual(fetchFixture);
  });

  test('maps the opt-in cardano-wallet-backend chain tip to best block', async () => {
    const originalCardanoWalletBackend = { ...(global: any).CONFIG.cardanoWalletBackend };
    (global: any).CONFIG.cardanoWalletBackend = {
      enabled: true,
      mainnet: 'http://localhost:3010/',
      preprod: 'http://localhost:3010/',
    };
    const fetchFixture = {
      block: 3500000,
      epoch: 199,
      slot: 86400123,
      hash: 'aa11bb22',
      blockTime: 1700000000,
    };
    (global: any).fetch = jest.fn(() => successfulJsonResponse(fetchFixture));
    (AbortSignal: any).timeout = jest.fn(() => new AbortController().signal);

    try {
      const fetcher = new AdaRemoteFetcher(
        () => '5.23.200',
        () => 'en-US',
        () => 'chrome'
      );
      const bestBlock = await fetcher.getBestBlock({
        network: backendNetwork(),
      });

      expect((global: any).fetch).toHaveBeenCalledWith(
        'http://localhost:3010/v1/chain/tip',
        expect.objectContaining({
          method: 'GET',
          headers: {
            'yoroi-version': '5.23.200',
            'yoroi-locale': 'en-US',
          },
        })
      );
      expect(bestBlock).toEqual({
        height: 3500000,
        epoch: 199,
        slot: 86400123,
        hash: 'aa11bb22',
      });
    } finally {
      (global: any).CONFIG.cardanoWalletBackend = originalCardanoWalletBackend;
    }
  });

  test('builds and signs a local Cardano transaction fixture', async () => {
    const senderAddress = byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4');
    const senderUtxo = {
      amount: '1000001',
      receiver: senderAddress,
      tx_hash: '6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe',
      tx_index: 0,
      utxo_id: '6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe0',
      assets: [],
      addressing: {
        path: [0, 135],
        startLevel: Bip44DerivationLevels.CHAIN.level,
      },
    };
    const output = new MultiToken(
      [
        {
          amount: new BigNumber(5001),
          identifier: DEFAULT_TOKEN.Identifier,
          networkId: CARDANO_MAINNET.NetworkId,
        },
      ],
      DEFAULT_TOKEN_CONTEXT
    );

    const unsignedTx = await newAdaUnsignedTx(
      [
        {
          address: senderAddress,
          amount: output,
        },
      ],
      undefined,
      [senderUtxo],
      new BigNumber(0),
      protocolParams(),
      [],
      [],
      true,
      undefined,
      CARDANO_MAINNET.NetworkId
    );
    const accountPrivateKey = RustModule.WalletV4.Bip32PrivateKey.from_hex(
      '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d'
    );
    const signedTx = signTransaction(
      unsignedTx.senderUtxos,
      unsignedTx.txBuilder.build().to_bytes(),
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey,
      null,
      undefined
    );
    const bootstrapWitnesses = signedTx.witness_set().bootstraps();
    const signedFee = signedTx.body().fee().to_str();

    expect(unsignedTx.senderUtxos).toEqual([senderUtxo]);
    expect(new BigNumber(signedFee).gt(0)).toEqual(true);
    expect(bootstrapWitnesses == null ? 0 : bootstrapWitnesses.len()).toEqual(1);
  });

  test('keeps dApp connector public methods wired to expected RPC contracts', async () => {
    const rpc = jest.fn((method, params, returnType) => {
      if (method === 'get_stake_key') {
        return Promise.resolve({ key: 'stake-key', isRegistered: true });
      }
      return Promise.resolve({ method, params, returnType });
    });
    const CardanoAPI = installCardanoApiForTest();
    const api = new CardanoAPI({ walletId: 'wallet-id', pubkey: 'wallet-pubkey' }, rpc);

    api.experimental.setReturnType('json');

    await expect(api.getExtensions()).resolves.toEqual([{ cip: 95 }, { cip: 103 }]);
    await api.getNetworkId();
    await api.getBalance();
    await api.getUsedAddresses({ page: 0, limit: 2 });
    await api.getUnusedAddresses();
    await api.getRewardAddresses();
    await api.getChangeAddress();
    await api.getUtxos('1000', { page: 1, limit: 3 });
    await api.submitTx('tx-hex');
    await api.signTx('body-hex', true);
    await api.signTx({ tx: 'full-tx-hex', partialSign: false, returnTx: true });
    await api.signData('addr-hex', 'payload-hex');
    await api.getCollateral({ amount: 5000000 });
    await api.getCollateralUtxos('');
    await api.cip95.getPubDRepKey();
    await expect(api.cip95.getRegisteredPubStakeKeys()).resolves.toEqual(['stake-key']);
    await expect(api.cip95.getUnregisteredPubStakeKeys()).resolves.toEqual([]);
    await api.cip95.signData('addr-hex', 'payload-hex');
    await api.cip103.signTxs([{ cbor: 'bulk-body-hex' }]);
    await api.cip103.submitTxs(['bulk-tx-hex']);

    expect(() => api.signTx(null)).toThrow('.signTx argument cannot be null!');
    expect(() => api.experimental.setReturnType('hex')).toThrow('Possible return type values are: "cbor" or "json"');
    expect(rpc.mock.calls).toEqual([
      ['get_network_id', [], 'json'],
      ['get_balance', ['*'], 'json'],
      ['get_used_addresses', [{ page: 0, limit: 2 }], 'json'],
      ['get_unused_addresses', [], 'json'],
      ['get_reward_addresses/cardano', [], 'json'],
      ['get_change_address', [], 'json'],
      ['get_utxos/cardano', ['1000', { page: 1, limit: 3 }], 'json'],
      ['submit_tx', ['tx-hex'], 'json'],
      ['sign_tx/cardano', [{ tx: 'body-hex', partialSign: true, returnTx: false }], 'json'],
      ['sign_tx/cardano', [{ tx: 'full-tx-hex', partialSign: false, returnTx: true }], 'json'],
      ['sign_data', ['addr-hex', 'payload-hex'], 'json'],
      ['get_collateral_utxos', ['5000000'], 'json'],
      ['get_collateral_utxos', [null], 'json'],
      ['get_drep_key', [], 'json'],
      ['get_stake_key', [], 'json'],
      ['get_stake_key', [], 'json'],
      ['cip95_sign_data', ['addr-hex', 'payload-hex'], 'json'],
      ['sign_tx/cardano', [{ tx: 'bulk-body-hex', partialSign: false, returnTx: false }], 'cbor'],
      ['submit_tx', ['bulk-tx-hex'], 'cbor'],
    ]);
  });

  test('keeps active backend config endpoints owned or local', () => {
    const activeConfigs = [
      ['mainnet', mainnetConfig],
      ['shelley-testnet', shelleyTestnetConfig],
      ['development', developmentConfig],
      ['test', testConfig],
    ];

    for (const [, config] of activeConfigs) {
      for (const rawUrl of Object.values(config.yoroiBackend)) {
        expect(isOwnedOrLocalBackendUrl(String(rawUrl))).toEqual(true);
      }
    }
  });
});

function isOwnedOrLocalBackendUrl(rawUrl: string): boolean {
  const { hostname, protocol } = new URL(rawUrl);
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const isOwned = hostname === 'blinklabs.cloud' || hostname.endsWith('.blinklabs.cloud');
  return (protocol === 'https:' && isOwned) || (protocol === 'http:' && isLocal);
}
