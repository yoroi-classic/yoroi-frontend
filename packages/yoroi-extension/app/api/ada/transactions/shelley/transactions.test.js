// @flow
import '../../lib/test-config.forTests';

import { schema } from 'lovefield';
import BigNumber from 'bignumber.js';
import type { CardanoAddressedUtxo } from '../types';
import type { RemoteUnspentOutput } from '../../lib/state-fetch/types';
import {
  maxSendableADA,
  newAdaUnsignedTx,
  newAdaUnsignedTxForConnector,
  newAdaUnsignedTxFromUtxo,
  genFilterSmallUtxo,
  sendAllUnsignedTxFromUtxo,
  signTransaction,
} from './transactions';
import { AssetOverflowError, NoOutputsError, NotEnoughMoneyToSendError } from '../../../common/errors';

import { loadLovefieldDB } from '../../lib/storage/database/index';
import { Bip44DerivationLevels } from '../../lib/storage/database/walletTypes/bip44/api/utils';
import type { Address, Addressing } from '../../lib/storage/models/PublicDeriver/interfaces';
import { byronAddrToHex } from '../../lib/storage/bridge/utils';

import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { CoinTypes, HARD_DERIVATION_START, STAKING_KEY_INDEX, WalletTypePurpose } from '../../../../config/numbersConfig';
import { defaultAssets, getCardanoHaskellBaseConfig, networks } from '../../lib/storage/database/prepackaged/networks';
import { MultiToken } from '../../../common/lib/MultiToken';
import {
  cardanoValueFromRemoteFormat,
  getTransactionFeeFromCbor,
  getTransactionTotalOutputFromCbor,
  identifierSplit,
  multiTokenFromRemote,
} from '../utils';
import { getStakingKeyHashesInTransactionBody } from '../../lib/cardanoCrypto/utils';
import { derivePrivateByAddressing } from '../../lib/cardanoCrypto/deriveByAddressing';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';
import { createCertificate } from '../../lib/storage/bridge/delegationUtils';
import { createMetadata } from '../../lib/storage/bridge/metadataUtils';
import { extractSwapCmlTransaction } from '../../../../stores/ada/swapCmlTx';
import { HaskellShelleyTxSignRequest } from './HaskellShelleyTxSignRequest';

const network = networks.CardanoMainnet;
const defaultIdentifier = defaultAssets.filter(asset => asset.NetworkId === network.NetworkId)[0].Identifier;

const testAssetId = 'd27197682d71905c087c5c3b61b10e6d746db0b9bef351014d75bb26.6e69636f696e';

function bech32ToHex(s: string): string {
  return RustModule.WalletV4.Address.from_bech32(s).to_hex();
}

function inspectCmlTransaction(bytes: Uint8Array): any {
  return RustModule.WasmScope(Module => {
    const transaction = Module.CML.Transaction.from_cbor_bytes(bytes);
    const body = transaction.body();
    const witnesses = transaction.witness_set();
    return {
      certificatesHex: body.certs() == null
        ? undefined
        : Array.from({ length: body.certs().len() }, (_, index) => bytesToHex(body.certs().get(index).to_cbor_bytes())),
      withdrawalCount: body.withdrawals()?.len() ?? 0,
      fee: body.fee().toString(),
      outputCount: body.outputs().len(),
      outputCoinTotal: Array.from({ length: body.outputs().len() }, (_, index) =>
        new BigNumber(body.outputs().get(index).amount().coin().toString())
      ).reduce((total, amount) => total.plus(amount), new BigNumber(0)).toString(),
      finalOutputCoin: body.outputs().get(body.outputs().len() - 1).amount().coin().toString(),
      vkeyWitnessCount: witnesses.vkeywitnesses()?.len() ?? 0,
      vkeyHashes: witnesses.vkeywitnesses() == null
        ? []
        : Array.from({ length: witnesses.vkeywitnesses().len() }, (_, index) => witnesses.vkeywitnesses().get(index).vkey().hash().to_hex()),
      hasNativeScripts: witnesses.native_scripts() != null,
      hasBootstrapWitnesses: witnesses.bootstrap_witnesses() != null,
    };
  });
}

function inspectCmlBody(bytes: Uint8Array): {| auxiliaryDataHash: ?string, fee: string, inputCount: number, outputTotal: string, outputs: Array<string> |} {
  return RustModule.WasmScope(Module => {
    const body = Module.CML.TransactionBody.from_cbor_bytes(bytes);
    const outputs = body.outputs();
    const outputCoins = Array.from({ length: outputs.len() }, (_, index) => outputs.get(index).amount().coin());
    return {
      fee: body.fee().toString(),
      auxiliaryDataHash: body.auxiliary_data_hash()?.to_hex(),
      inputCount: body.inputs().len(),
      outputTotal: outputCoins.reduce((sum, coin) => sum + coin, 0n).toString(),
      outputs: outputCoins.map(coin => coin.toString()),
    };
  });
}

function inspectCmlAssetAmounts(bytes: Uint8Array, assetId: string): Array<string> {
  const asset = identifierSplit(assetId);
  return RustModule.WasmScope(Module => {
    const outputs = Module.CML.TransactionBody.from_cbor_bytes(bytes).outputs();
    return Array.from({ length: outputs.len() }, (_, index) => {
      const multiAsset = outputs.get(index).amount().multi_asset();
      const amount = multiAsset.get(
        Module.CML.ScriptHash.from_hex(asset.policyId),
        Module.CML.AssetName.from_raw_bytes(hexToBytes(asset.name))
      );
      return amount == null ? '0' : amount.toString();
    }).filter(amount => amount !== '0');
  });
}

const genSampleUtxos: void => Array<RemoteUnspentOutput> = () => [
  {
    amount: '701',
    receiver: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
    tx_hash: '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f',
    tx_index: 0,
    utxo_id: '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f0',
    assets: [],
  },
  {
    amount: '1000001',
    receiver: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
    tx_hash: '6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe',
    tx_index: 0,
    utxo_id: '6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe0',
    assets: [],
  },
  {
    amount: '10000001',
    receiver: byronAddrToHex('Ae2tdPwUPEZ4xAL3nxLq4Py7BfS1D2tJ3u2rxZGnrAXC8TNkWhTaz41J3FN'),
    tx_hash: '0df0273e382739f8b4ae3783d81168093e78e0b48ec2c5430ff03d444806a173',
    tx_index: 0,
    utxo_id: '0df0273e382739f8b4ae3783d81168093e78e0b48ec2c5430ff03d444806a1730',
    assets: [],
  },
  {
    amount: '30000000',
    receiver: bech32ToHex(
      // external addr 0, staking key 0
      'addr1q8gpjmyy8zk9nuza24a0f4e7mgp9gd6h3uayp0rqnjnkl54v4dlyj0kwfs0x4e38a7047lymzp37tx0y42glslcdtzhqphf76y'
    ),
    tx_hash: '86e36b6a65d82c9dcc0370b0ee3953aee579db0b837753306405c28a74de5550',
    tx_index: 0,
    utxo_id: '86e36b6a65d82c9dcc0370b0ee3953aee579db0b837753306405c28a74de55500',
    assets: [],
  },
  {
    amount: '2000001',
    receiver: bech32ToHex(
      // external addr 0, staking key 0
      'addr1q8gpjmyy8zk9nuza24a0f4e7mgp9gd6h3uayp0rqnjnkl54v4dlyj0kwfs0x4e38a7047lymzp37tx0y42glslcdtzhqphf76y'
    ),
    tx_hash: '86e36b6a65d82c9dcc0370b0ee3953aee579db0b837753306405c28a74de5550',
    tx_index: 1,
    utxo_id: '86e36b6a65d82c9dcc0370b0ee3953aee579db0b837753306405c28a74de55501',
    assets: [
      {
        amount: '1234',
        assetId: testAssetId,
        policyId: testAssetId.split('.')[0],
        name: testAssetId.split('.')[1],
      },
    ],
  },
  {
    amount: '1000001',
    receiver: bech32ToHex(
      // external addr 0, staking key 0
      'addr1q8gpjmyy8zk9nuza24a0f4e7mgp9gd6h3uayp0rqnjnkl54v4dlyj0kwfs0x4e38a7047lymzp37tx0y42glslcdtzhqphf76y'
    ),
    tx_hash: '86e36b6a65d82c9dcc0370b0ee3953aee579db0b837753306405c28a74de5550',
    tx_index: 2,
    utxo_id: '86e36b6a65d82c9dcc0370b0ee3953aee579db0b837753306405c28a74de55502',
    assets: [
      {
        amount: '18446744073709551615', // max u64
        assetId: testAssetId,
        policyId: testAssetId.split('.')[0],
        name: testAssetId.split('.')[1],
      },
    ],
  },
];

const genSampleAdaAddresses: void => Array<{| ...Address, ...Addressing |}> = () => [
  {
    address: byronAddrToHex('Ae2tdPwUPEZEtwz7LKtJn9ub8y7ireuj3sq2yUCZ57ccj6ZkJKn7xEiApV9'),
    addressing: {
      path: [1, 11],
      startLevel: Bip44DerivationLevels.CHAIN.level,
    },
  },
  {
    address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
    addressing: {
      path: [0, 135],
      startLevel: Bip44DerivationLevels.CHAIN.level,
    },
  },
  {
    address: byronAddrToHex('Ae2tdPwUPEZ4xAL3nxLq4Py7BfS1D2tJ3u2rxZGnrAXC8TNkWhTaz41J3FN'),
    addressing: {
      path: [0, 134],
      startLevel: Bip44DerivationLevels.CHAIN.level,
    },
  },
  {
    address: bech32ToHex(
      'addr1q8gpjmyy8zk9nuza24a0f4e7mgp9gd6h3uayp0rqnjnkl54v4dlyj0kwfs0x4e38a7047lymzp37tx0y42glslcdtzhqphf76y'
    ),
    addressing: {
      path: [0, 0],
      startLevel: Bip44DerivationLevels.CHAIN.level,
    },
  },
];
const genAddressedUtxos: void => Array<CardanoAddressedUtxo> = () => {
  const addressingMap = new Map<string, Addressing>();
  for (const address of genSampleAdaAddresses()) {
    addressingMap.set(address.address, { addressing: address.addressing });
  }
  return genSampleUtxos().map(utxo => {
    const addressing = addressingMap.get(utxo.receiver);
    if (addressing == null) throw new Error('Should never happen');
    return {
      ...utxo,
      ...addressing,
    };
  });
};

beforeAll(async () => {
  await RustModule.load();
  await loadLovefieldDB(schema.DataStoreType.MEMORY);
});

function getProtocolParams(): {|
  linearFeeCoefficient: string,
  linearFeeConstant: string,
  coinsPerUtxoByte: string,
  poolDeposit: string,
  keyDeposit: string,
  networkId: number,
|} {
  return {
    linearFeeCoefficient: '2',
    linearFeeConstant: '500',
    coinsPerUtxoByte: '1',
    poolDeposit: '500',
    keyDeposit: '500',
    networkId: Number(network.BaseConfig[0].ChainNetworkId),
  };
}

function getSendAllProtocolParams(): {|
  linearFeeCoefficient: string,
  linearFeeConstant: string,
  coinsPerUtxoByte: string,
  poolDeposit: string,
  keyDeposit: string,
  networkId: number,
|} {
  return {
    linearFeeCoefficient: '2',
    linearFeeConstant: '500',
    coinsPerUtxoByte: '1',
    poolDeposit: '500',
    keyDeposit: '500',
    networkId: network.NetworkId,
  };
}

describe('Create unsigned TX from UTXO', () => {
  it('Should fail due to insufficient funds (bigger than all inputs)', async () => {
    const sampleUtxos = genSampleUtxos();
    const output = new MultiToken(
      [
        {
          // bigger than input including fees
          amount: new BigNumber(1900001),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    const utxos: Array<RemoteUnspentOutput> = [sampleUtxos[1]];
    await expect(
      newAdaUnsignedTxFromUtxo(
        [
          {
            address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
            amount: output,
          },
        ],
        undefined,
        utxos,
        new BigNumber(0),
        getProtocolParams(),
        [],
        [],
        true,
        undefined,
        network.NetworkId
      )
    ).rejects.toThrow(NotEnoughMoneyToSendError);
  });

  it('Should fail due to insufficient funds (no inputs)', async () => {
    const output = new MultiToken(
      [
        {
          // bigger than input including fees
          amount: new BigNumber(1000000),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    await expect(
      newAdaUnsignedTxFromUtxo(
        [
          {
            address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
            amount: output,
          },
        ],
        undefined,
        [],
        new BigNumber(0),
        getProtocolParams(),
        [],
        [],
        true,
        undefined,
        network.NetworkId
      )
    ).rejects.toThrow(NotEnoughMoneyToSendError);
  });

  it('Should fail due to insufficient funds (not enough to cover fees)', async () => {
    const sampleUtxos = genSampleUtxos();
    const output = new MultiToken(
      [
        {
          // bigger than input including fees
          amount: new BigNumber(1000000),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    const utxos: Array<RemoteUnspentOutput> = [sampleUtxos[0]];
    await expect(
      newAdaUnsignedTxFromUtxo(
        [
          {
            address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
            amount: output,
          },
        ],
        undefined,
        utxos,
        new BigNumber(0),
        getProtocolParams(),
        [],
        [],
        true,
        undefined,
        network.NetworkId
      )
    ).rejects.toThrow(NotEnoughMoneyToSendError);
  });

  it('Should fail due to insufficient funds (no outputs disallowed)', async () => {
    const sampleUtxos = genSampleUtxos();
    const sampleAdaAddresses = genSampleAdaAddresses();
    // should fail because we disallow burning extra ADA in fees
    await expect(
      newAdaUnsignedTxFromUtxo(
        [],
        sampleAdaAddresses[0],
        [sampleUtxos[1]],
        new BigNumber(0),
        {
          ...getProtocolParams(),
          // high enough that we can't send the remaining amount as change
          coinsPerUtxoByte: '12375',
        },
        [],
        [],
        false,
        undefined,
        network.NetworkId
      )
    ).rejects.toThrow(NotEnoughMoneyToSendError);
    // should avoid failing by consuming the second UTXO
    await expect(
      newAdaUnsignedTxFromUtxo(
        [],
        sampleAdaAddresses[0],
        [sampleUtxos[1], sampleUtxos[0]],
        new BigNumber(0),
        {
          ...getProtocolParams(),
          coinsPerUtxoByte: '3875',
        },
        [],
        [],
        false,
        undefined,
        network.NetworkId
      )
    ).resolves.not.toThrow(NotEnoughMoneyToSendError);
    // should pass because we can add a change
    await expect(
      newAdaUnsignedTxFromUtxo(
        [],
        sampleAdaAddresses[0],
        [sampleUtxos[1]],
        new BigNumber(0),
        {
          ...getProtocolParams(),
          coinsPerUtxoByte: '3750',
        },
        [],
        [],
        false,
        undefined,
        network.NetworkId
      )
    ).resolves.not.toThrow(NotEnoughMoneyToSendError);
  });

  it('Should fail due to no outputs', async () => {
    const sampleUtxos = genSampleUtxos();
    const utxos: Array<RemoteUnspentOutput> = [sampleUtxos[1]];
    await expect(
      newAdaUnsignedTxFromUtxo(
        [],
        undefined,
        utxos,
        new BigNumber(0),
        getProtocolParams(),
        [],
        [],
        false,
        undefined,
        network.NetworkId
      )
    ).rejects.toThrow(NoOutputsError);
  });

  it('Should pick random pure inputs when using input selection', async () => {
    const utxos: Array<RemoteUnspentOutput> = genSampleUtxos();
    const sampleAdaAddresses = genSampleAdaAddresses();

    const output = new MultiToken(
      [
        {
          // smaller than input
          amount: new BigNumber(1001),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    async function testTxConstruction(randomValues: number[]): Promise<void> {
      randomValues.reduce((m, v) => m.mockReturnValueOnce(v), jest.spyOn(global.Math, 'random'));

      const unsignedTxResponse = await newAdaUnsignedTxFromUtxo(
        [
          {
            address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
            amount: output,
          },
        ],
        sampleAdaAddresses[0],
        [utxos[0], utxos[1], utxos[2], utxos[3]],
        new BigNumber(0),
        getProtocolParams(),
        [],
        [],
        true,
        undefined,
        network.NetworkId
      );

      jest.spyOn(global.Math, 'random').mockRestore();

      const body = inspectCmlBody(unsignedTxResponse.txBuilder);
      const inputTotal = unsignedTxResponse.senderUtxos.reduce((total, utxo) => total.plus(utxo.amount), new BigNumber(0));
      const outputTotal = body.outputs.reduce((total, amount) => total.plus(amount), new BigNumber(0));
      expect(inputTotal.minus(outputTotal).toString()).toBe(body.fee);
      expect(unsignedTxResponse.senderUtxos.every(utxo => new BigNumber(utxo.amount).gt(2_000_000))).toBe(true);
      expect(new BigNumber(body.fee).gt(0)).toBe(true);
    }

    await testTxConstruction([0.2, 0.2, 0.2, 0.2, 0.2]);
    await testTxConstruction([0.7, 0.7, 0.7, 0.7, 0.7]);
    await testTxConstruction([0.7, 0.2, 0.7, 0.2, 0.7]);
  });

  it('Should pick inputs with tokens when using input selection', async () => {
    const utxos: Array<RemoteUnspentOutput> = genSampleUtxos();
    const sampleAdaAddresses = genSampleAdaAddresses();

    const output = new MultiToken(
      [
        {
          // smaller than input
          amount: new BigNumber(1001),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
        {
          amount: new BigNumber(1000),
          identifier: testAssetId,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    const unsignedTxResponse = await newAdaUnsignedTxFromUtxo(
      [
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
          amount: output,
        },
      ],
      sampleAdaAddresses[0],
      [utxos[0], utxos[1], utxos[2], utxos[3], utxos[4]],
      new BigNumber(0),
      getProtocolParams(),
      [],
      [],
      true,
      undefined,
      network.NetworkId
    );

    const body = inspectCmlBody(unsignedTxResponse.txBuilder);
    const selectedAda = unsignedTxResponse.senderUtxos.reduce((total, utxo) => total.plus(utxo.amount), new BigNumber(0));
    const outputAda = body.outputs.reduce((total, amount) => total.plus(amount), new BigNumber(0));
    expect(unsignedTxResponse.senderUtxos).toContain(utxos[4]);
    expect(unsignedTxResponse.senderUtxos.every(utxo => utxo.assets.length > 0 || new BigNumber(utxo.amount).gt(2_000_000))).toBe(true);
    expect(selectedAda.minus(outputAda).toString()).toBe(body.fee);
    expect(inspectCmlAssetAmounts(unsignedTxResponse.txBuilder, testAssetId).sort()).toEqual(['1000', '234']);
  });

  it('Should fail when not enough ADA to avoid burning tokens', async () => {
    const utxos: Array<RemoteUnspentOutput> = genSampleUtxos();
    const sampleAdaAddresses = genSampleAdaAddresses();

    const output = new MultiToken(
      [
        {
          // smaller than input
          amount: new BigNumber(2000000),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
        {
          amount: new BigNumber(1000),
          identifier: testAssetId,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    await expect(
      newAdaUnsignedTxFromUtxo(
        [
          {
            address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
            amount: output,
          },
        ],
        sampleAdaAddresses[0],
        [utxos[4]],
        new BigNumber(0),
        {
          ...getProtocolParams(),
          // high enough that we can't send the remaining amount as change
          coinsPerUtxoByte: '4310',
        },
        [],
        [],
        true,
        undefined,
        network.NetworkId
      )
    ).rejects.toThrow(NotEnoughMoneyToSendError);
  });

  it('Should succeed when not enough ADA to avoid burning tokens but is sending all', () => {
    const utxos: Array<RemoteUnspentOutput> = genSampleUtxos();
    expect(() =>
      sendAllUnsignedTxFromUtxo(
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
        },
        [utxos[4]],
        new BigNumber(0),
        { ...getSendAllProtocolParams(), coinsPerUtxoByte: '4310' },
        undefined,
        network.NetworkId
      )
    ).not.toThrow(NotEnoughMoneyToSendError);
  });

  it('Should fail when insufficient ADA when forcing change', async () => {
    const sampleUtxos = genSampleUtxos();
    const sampleAdaAddresses = genSampleAdaAddresses();
    const output = new MultiToken(
      [
        {
          // bigger than input including fees
          amount: new BigNumber(2900001),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    await expect(
      newAdaUnsignedTxFromUtxo(
        [
          {
            address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
            amount: output,
          },
        ],
        sampleAdaAddresses[0],
        [sampleUtxos[4]],
        new BigNumber(0),
        getProtocolParams(),
        [],
        [],
        true,
        undefined,
        network.NetworkId
      )
    ).rejects.toThrow(NotEnoughMoneyToSendError);
  });

  it('Should fail when sending all where sum of tokens > 2^64', () => {
    const sampleUtxos = genSampleUtxos();

    expect(() =>
      sendAllUnsignedTxFromUtxo(
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
        },
        [sampleUtxos[4], sampleUtxos[5]],
        new BigNumber(0),
        getSendAllProtocolParams(),
        undefined,
        network.NetworkId
      )
    ).toThrow(AssetOverflowError);
  });

  it('Should fail when sending where sum of tokens > 2^64', async () => {
    const sampleUtxos = genSampleUtxos();
    const sampleAdaAddresses = genSampleAdaAddresses();
    const output = new MultiToken(
      [
        {
          // need to include both the input txs to satisfy this amount,
          // but the asset amount of them overflows when added
          amount: new BigNumber(3000000),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    await expect(
      newAdaUnsignedTxFromUtxo(
        [
          {
            address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
            amount: output,
          },
        ],
        sampleAdaAddresses[0],
        [sampleUtxos[4], sampleUtxos[5]],
        new BigNumber(0),
        getProtocolParams(),
        [],
        [],
        true,
        undefined,
        network.NetworkId
      )
    ).rejects.toThrow(AssetOverflowError);
  });

  it('Should balance selected inputs, outputs, and fee', async () => {
    const utxos = [
      {
        amount: '10831727',
        receiver: '82d818582183581ce3a1faa5b54bd1485a424d8f9b5e75296b328a2a624ef1d2f4c7b480a0001a88e5cdab',
        tx_hash: '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f',
        tx_index: 0,
        utxo_id: '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f0',
        assets: [],
      },
      {
        amount: '1000000',
        receiver: '82d818582183581ce3a1faa5b54bd1485a424d8f9b5e75296b328a2a624ef1d2f4c7b480a0001a88e5cdab',
        tx_hash: '6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe',
        tx_index: 0,
        utxo_id: '6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe0',
        assets: [],
      },
    ];
    const sampleAdaAddresses = genSampleAdaAddresses();
    const output = new MultiToken(
      [
        {
          amount: new BigNumber(10000000),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    const result = await newAdaUnsignedTxFromUtxo(
      [
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
          amount: output,
        },
      ],
      sampleAdaAddresses[0],
      utxos,
      new BigNumber(0),
      {
        ...getProtocolParams(),
        coinsPerUtxoByte: '4310',
      },
      [],
      [],
      true,
      undefined,
      network.NetworkId
    );

    const body = inspectCmlBody(result.txBuilder);
    const inputTotal = result.senderUtxos.reduce((total, utxo) => total.plus(utxo.amount), new BigNumber(0));
    const outputTotal = body.outputs.reduce((total, amount) => total.plus(amount), new BigNumber(0));
    expect(inputTotal.minus(outputTotal).toString()).toBe(body.fee);
    expect(new BigNumber(body.fee).gt(0)).toBe(true);
  });
});

describe('Create unsigned TX from addresses', () => {
  it('Should create a valid transaction without change', async () => {
    const addressedUtxos = genAddressedUtxos();

    const output = new MultiToken(
      [
        {
          // smaller than input
          amount: new BigNumber(5001),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );
    const unsignedTxResponse = await newAdaUnsignedTx(
      [
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
          amount: output,
        },
      ],
      undefined,
      [addressedUtxos[1]],
      new BigNumber(0),
      getProtocolParams(),
      [],
      [],
      true,
      undefined,
      network.NetworkId
    );
    expect(unsignedTxResponse.senderUtxos).toEqual([addressedUtxos[1]]);

    const body = inspectCmlBody(unsignedTxResponse.txBuilder);
    expect(body.outputs).toEqual(['5001']);
    expect(body.fee).toEqual('995000');
    // burns remaining amount
    expect(
      new BigNumber(addressedUtxos[1].amount).minus(body.outputs[0]).toString()
    ).toEqual(body.fee);
  });
});

describe('Create signed transactions', () => {
  it('Witness should match on valid private key', async () => {
    const addressedUtxos = genAddressedUtxos();

    const output = new MultiToken(
      [
        {
          // smaller than input
          amount: new BigNumber(5001),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    // Fix the random value to handle the pure inputs prioritisation properly
    jest.spyOn(global.Math, 'random').mockReturnValue(0.7);

    const unsignedTxResponse = await newAdaUnsignedTx(
      [
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
          amount: output,
        },
      ],
      undefined,
      [addressedUtxos[0], addressedUtxos[1]],
      new BigNumber(0),
      getProtocolParams(),
      [],
      [],
      true,
      undefined,
      network.NetworkId
    );

    jest.spyOn(global.Math, 'random').mockRestore();

    const accountPrivateKey = RustModule.WalletV4.Bip32PrivateKey.from_hex(
      '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d'
    );
    const signedTx = signTransaction(
      unsignedTxResponse.senderUtxos,
      unsignedTxResponse.txBuilder,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey,
      null,
      undefined
    );
    const witnessSummary = RustModule.WasmScope(Module => {
      const witnesses = Module.CML.Transaction.from_cbor_bytes(signedTx).witness_set();
      return {
        hasVkeys: witnesses.vkeywitnesses() != null,
        hasNativeScripts: witnesses.native_scripts() != null,
        bootstrapCount: witnesses.bootstrap_witnesses()?.len() ?? 0,
      };
    });
    expect(witnessSummary.hasVkeys).toEqual(false);
    expect(witnessSummary.hasNativeScripts).toEqual(false);
    expect(witnessSummary.bootstrapCount).toEqual(1);
    const cmlSummary = inspectCmlTransaction(signedTx);
    expect(getTransactionFeeFromCbor(bytesToHex(signedTx)).toString()).toBe(cmlSummary.fee);
    expect(
      getTransactionTotalOutputFromCbor(bytesToHex(signedTx), { defaultIdentifier, defaultNetworkId: network.NetworkId })
        .getDefaultEntry().amount.toString()
    ).toBe(cmlSummary.outputCoinTotal);
  });

  it('Witness should with addressing from root', () => {
    const accountPrivateKey = RustModule.WalletV4.Bip32PrivateKey.from_hex(
      '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d'
    );
    const inputs = RustModule.WalletV4.TransactionInputs.new();
    inputs.add(
      RustModule.WalletV4.TransactionInput.new(
        RustModule.WalletV4.TransactionHash.from_hex('05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f'),
        0
      )
    );
    inputs.add(
      RustModule.WalletV4.TransactionInput.new(
        RustModule.WalletV4.TransactionHash.from_hex('6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe'),
        0
      )
    );
    const outputs = RustModule.WalletV4.TransactionOutputs.new();
    outputs.add(
      RustModule.WalletV4.TransactionOutput.new(
        RustModule.WalletV4.Address.from_hex(byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4')),
        RustModule.WalletV4.Value.new(RustModule.WalletV4.BigNum.from_str('5001'))
      )
    );
    const txBody = RustModule.WalletV4.TransactionBody.new(inputs, outputs, RustModule.WalletV4.BigNum.from_str('1000'), 0);

    const signedTx = signTransaction(
      [
        {
          amount: '7001',
          receiver: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
          tx_hash: '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f',
          tx_index: 0,
          utxo_id: '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f0',
          addressing: {
            path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START + 0, 0, 135],
            startLevel: 1,
          },
          assets: [],
        },
        {
          amount: '1000001',
          receiver: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
          tx_hash: '6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe',
          tx_index: 0,
          utxo_id: '6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe0',
          addressing: {
            path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START + 0, 0, 135],
            startLevel: 1,
          },
          assets: [],
        },
      ],
      txBody,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey,
      null,
      undefined
    );
    const witnesses = signedTx.witness_set();

    expect(witnesses.vkeys()).toEqual(undefined);
    expect(witnesses.native_scripts()).toEqual(undefined);
    const bootstrapWits = witnesses.bootstraps();
    if (bootstrapWits == null) throw new Error('Bootstrap witnesses should not be null');
    expect(bootstrapWits.len()).toEqual(1); // note: only one witness since we got rid of duplicates

    expect(bootstrapWits.get(0).to_hex()).toEqual(
      '8458208fb03c3aa052f51c086c54bd4059ead2d2e426ac89fa4b3ce41cbfd8800b51c05840593e3d54a9bf9b5e6778ddb8930bdd9a87dd29f046fa3ba9d49bd1b7ddecdb6a1ced6016cdab663ff21596380392786d67f70e8d7c200fc042d669981db11c0658202623fceb96b07408531a5cb259f53845a38d6b68928e7c0c7e390f07545d0e6241a0'
    );
  });

  it('Transaction should support certificates', async () => {
    const accountPrivateKey = RustModule.WalletV4.Bip32PrivateKey.from_hex(
      '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247'
    );
    const stakingKey = accountPrivateKey.derive(2).derive(STAKING_KEY_INDEX).to_raw_key();

    const addressedUtxos = genAddressedUtxos();

    const output = new MultiToken(
      [
        {
          // smaller than input
          amount: new BigNumber(5001),
          identifier: defaultIdentifier,
          networkId: network.NetworkId,
        },
      ],
      {
        defaultIdentifier,
        defaultNetworkId: network.NetworkId,
      }
    );

    const unsignedTxResponse = await newAdaUnsignedTx(
      [
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
          amount: output,
        },
      ],
      undefined,
      [addressedUtxos[3]],
      new BigNumber(0),
      getProtocolParams(),
      createCertificate(stakingKey.to_public().hash().to_hex(), false, '1b268f4cba3faa7e36d8a0cc4adca2096fb856119412ee7330f692b5', undefined),
      [],
      true,
      undefined,
      network.NetworkId
    );
    const expectedCertificates = RustModule.WalletV4.Certificates.new();
    const stakeCredential = RustModule.WalletV4.Credential.from_keyhash(stakingKey.to_public().hash());
    expectedCertificates.add(
      RustModule.WalletV4.Certificate.new_stake_registration(RustModule.WalletV4.StakeRegistration.new(stakeCredential))
    );
    expectedCertificates.add(
      RustModule.WalletV4.Certificate.new_stake_delegation(
        RustModule.WalletV4.StakeDelegation.new(
          stakeCredential,
          RustModule.WalletV4.Ed25519KeyHash.from_hex('1b268f4cba3faa7e36d8a0cc4adca2096fb856119412ee7330f692b5')
        )
      )
    );
    const certificateInfo = inspectCmlTransaction(RustModule.WasmScope(Module =>
      Module.CML.Transaction.new(
        Module.CML.TransactionBody.from_cbor_bytes(unsignedTxResponse.txBuilder),
        Module.CML.TransactionWitnessSet.new(),
        true
      ).to_cbor_bytes()
    ));
    expect(certificateInfo.certificatesHex).toEqual(
      Array.from({ length: expectedCertificates.len() }, (_, index) => bytesToHex(expectedCertificates.get(index).to_bytes()))
    );
    const signedTx = signTransaction(
      unsignedTxResponse.senderUtxos,
      unsignedTxResponse.txBuilder,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey,
      stakingKey.as_bytes(),
      undefined
    );
    const signedInfo = inspectCmlTransaction(signedTx);
    expect(getTransactionFeeFromCbor(bytesToHex(signedTx)).toString()).toBe(signedInfo.fee);
    expect(
      getTransactionTotalOutputFromCbor(bytesToHex(signedTx), { defaultIdentifier, defaultNetworkId: network.NetworkId })
        .getDefaultEntry().amount.toString()
    ).toBe(signedInfo.outputCoinTotal);
    expect(signedInfo.vkeyWitnessCount).toEqual(2);
    expect(signedInfo.hasNativeScripts).toEqual(false);
    expect(signedInfo.hasBootstrapWitnesses).toEqual(false);
  });

  it('Transaction should support withdrawals', async () => {
    const accountPrivateKey = RustModule.WalletV4.Bip32PrivateKey.from_hex(
      '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247'
    );
    const stakingKey = accountPrivateKey.derive(2).derive(STAKING_KEY_INDEX).to_raw_key();
    const stakingKeyCredential = RustModule.WalletV4.Credential.from_keyhash(stakingKey.to_public().hash());

    if (network.BaseConfig[0].ChainNetworkId == null) {
      throw new Error(`missing network id`);
    }

    const protocolParams = getProtocolParams();
    const withdrawAmount = '1000000';
    const addressedUtxos = genAddressedUtxos();
    const sampleAdaAddresses = genSampleAdaAddresses();
    const unsignedTxResponse = await newAdaUnsignedTx(
      [],
      sampleAdaAddresses[3],
      [addressedUtxos[3]],
      new BigNumber(0),
      protocolParams,
      createCertificate(stakingKey.to_public().hash().to_hex(), true, undefined, undefined),
      [
        {
          address: RustModule.WalletV4.RewardAddress.new(
            Number.parseInt(network.BaseConfig[0].ChainNetworkId, 10),
            stakingKeyCredential
          ),
          amount: RustModule.WalletV4.BigNum.from_str(withdrawAmount),
        },
      ],
      true,
      undefined,
      network.NetworkId
    );

    const expectedCertificates = RustModule.WalletV4.Certificates.new();
    expectedCertificates.add(
      RustModule.WalletV4.Certificate.new_stake_deregistration(RustModule.WalletV4.StakeDeregistration.new(stakingKeyCredential))
    );
    const unsignedInfo = inspectCmlTransaction(RustModule.WasmScope(Module =>
      Module.CML.Transaction.new(
        Module.CML.TransactionBody.from_cbor_bytes(unsignedTxResponse.txBuilder),
        Module.CML.TransactionWitnessSet.new(),
        true
      ).to_cbor_bytes()
    ));
    const cmlReserializedBodyHex = RustModule.WasmScope(Module =>
      bytesToHex(Module.CML.TransactionBody.from_cbor_bytes(unsignedTxResponse.txBuilder).to_cbor_bytes())
    );
    expect(getStakingKeyHashesInTransactionBody(bytesToHex(unsignedTxResponse.txBuilder)).has(stakingKey.to_public().hash().to_hex())).toBe(true);
    expect(getStakingKeyHashesInTransactionBody(cmlReserializedBodyHex).has(stakingKey.to_public().hash().to_hex())).toBe(true);
    expect(
      RustModule.WasmScope(Module =>
        Module.CML.PrivateKey.from_extended_bytes(stakingKey.as_bytes()).to_public().hash().to_hex()
      )
    ).toBe(stakingKey.to_public().hash().to_hex());
    const expectedPaymentHashes = unsignedTxResponse.senderUtxos.map(utxo =>
      derivePrivateByAddressing({
        addressing: utxo.addressing,
        startingFrom: { level: Bip44DerivationLevels.ACCOUNT.level, key: accountPrivateKey },
      })
        .to_raw_key()
        .to_public()
        .hash()
        .to_hex()
    );
    expect(unsignedInfo.certificatesHex).toEqual(
      Array.from({ length: expectedCertificates.len() }, (_, index) => bytesToHex(expectedCertificates.get(index).to_bytes()))
    );

    const signedTx = signTransaction(
      unsignedTxResponse.senderUtxos,
      unsignedTxResponse.txBuilder,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey,
      stakingKey.as_bytes(),
      undefined
    );
    const signedInfo = inspectCmlTransaction(signedTx);
    expect(getTransactionFeeFromCbor(bytesToHex(signedTx)).toString()).toBe(signedInfo.fee);
    expect(
      getTransactionTotalOutputFromCbor(bytesToHex(signedTx), { defaultIdentifier, defaultNetworkId: network.NetworkId })
        .getDefaultEntry().amount.toString()
    ).toBe(signedInfo.outputCoinTotal);
    expect(expectedPaymentHashes).toEqual([]);
    expect(unsignedTxResponse.senderUtxos).toHaveLength(0);
    expect(signedInfo.vkeyHashes).toContain(stakingKey.to_public().hash().to_hex());
    expect(signedInfo.vkeyWitnessCount).toEqual(1);
    expect(signedInfo.hasNativeScripts).toEqual(false);
    expect(signedInfo.hasBootstrapWitnesses).toEqual(false);
    expect(unsignedInfo.withdrawalCount).toEqual(1);
    const fee = unsignedInfo.fee;
    expect(new BigNumber(fee).gt(0)).toBe(true);
    expect(unsignedInfo.outputCount).toEqual(1);
    expect(unsignedInfo.finalOutputCoin).toEqual(
      new BigNumber(withdrawAmount)
        .plus(protocolParams.keyDeposit)
        .minus(fee)
        .toString()
    );

  });
});

describe('Create sendAll unsigned TX from UTXO', () => {
  it('matches the legacy minimum-input fee cutoff for Shelley and Byron addresses', () => {
    const protocolParams = getSendAllProtocolParams();
    const cmlFilter = genFilterSmallUtxo({
      protocolParams: {
        linearFeeCoefficient: protocolParams.linearFeeCoefficient,
        linearFeeConstant: protocolParams.linearFeeConstant,
      },
    });
    const cslBuilder = RustModule.WalletV4TxBuilder({
      linearFee: RustModule.WalletV4.LinearFee.new(
        RustModule.WalletV4.BigNum.from_str(protocolParams.linearFeeCoefficient),
        RustModule.WalletV4.BigNum.from_str(protocolParams.linearFeeConstant)
      ),
      coinsPerUtxoByte: RustModule.WalletV4.BigNum.zero(),
      poolDeposit: RustModule.WalletV4.BigNum.zero(),
      keyDeposit: RustModule.WalletV4.BigNum.zero(),
    });

    for (const source of [genSampleUtxos()[1], genSampleUtxos()[3], genSampleUtxos()[4]]) {
      const utxo = {
        ...source,
        amount: '0',
      };
      const fee = cslBuilder
        .fee_for_input(
          RustModule.WalletV4.Address.from_hex(utxo.receiver),
          RustModule.WalletV4.TransactionInput.new(RustModule.WalletV4.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index),
          cardanoValueFromRemoteFormat(utxo)
        )
        .to_str();
      expect(cmlFilter({ ...utxo, amount: fee })).toBe(true);
      expect(cmlFilter({ ...utxo, amount: new BigNumber(fee).minus(1).toString() })).toBe(false);
    }
  });

  describe('Create send-all TX from UTXO', () => {
    it('Create a transaction involving all input with no change', () => {
      const sampleUtxos = genSampleUtxos();
      const utxos: Array<RemoteUnspentOutput> = [sampleUtxos[1], sampleUtxos[2]];
      const changeAddress = genSampleAdaAddresses()[0];
      const metadata = createMetadata([{ label: '0', data: { value: 1 } }]);
      const sendAllResponse = sendAllUnsignedTxFromUtxo(
        changeAddress,
        utxos,
        new BigNumber(0),
        getSendAllProtocolParams(),
        metadata.to_bytes(),
        network.NetworkId
      );

      const expectedInput = new BigNumber('11000002');
      expect(sendAllResponse.senderUtxos).toEqual([utxos[0], utxos[1]]);
      const body = inspectCmlBody(sendAllResponse.txBuilder);
      expect(body.inputCount).toBe(2);
      expect(expectedInput.minus(body.outputTotal).toString()).toBe(body.fee);
      expect(new BigNumber(body.fee).gt(0)).toBe(true);
      const auxiliaryData = RustModule.WalletV4.AuxiliaryData.from_bytes(metadata.to_bytes());
      expect(body.auxiliaryDataHash).toBe(RustModule.WalletV4.hash_auxiliary_data(auxiliaryData).to_hex());
      expect(sendAllResponse.changeAddr).toHaveLength(1);
      expect(sendAllResponse.changeAddr[0].address).toBe(changeAddress.address);
      expect(sendAllResponse.changeAddr[0].values.getDefaultEntry().amount.toString()).toBe(body.outputs[0]);
    });
  });

  it('extracts swap body, inputs, and metadata with CML', () => {
    const utxo = genSampleUtxos()[1];
    const receiver = genSampleAdaAddresses()[0];
    const metadata = createMetadata([{ label: '0', data: { value: 4 } }]);
    const response = sendAllUnsignedTxFromUtxo(
      receiver,
      [utxo],
      new BigNumber(0),
      getSendAllProtocolParams(),
      metadata.to_bytes(),
      network.NetworkId
    );
    const { fullTxHex, auxiliaryDataHex } = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const body = cml.TransactionBody.from_cbor_bytes(response.txBuilder);
      const auxiliaryData = cml.AuxiliaryData.from_cbor_bytes(metadata.to_bytes());
      const sourceAuxiliaryDataHex = auxiliaryData.to_cbor_hex();
      return {
        fullTxHex: cml.Transaction.new(body, cml.TransactionWitnessSet.new(), true, auxiliaryData).to_cbor_hex(),
        auxiliaryDataHex: sourceAuxiliaryDataHex,
      };
    });

    const extracted = extractSwapCmlTransaction(fullTxHex);
    expect(Array.from(extracted.bodyBytes)).toEqual(Array.from(response.txBuilder));
    expect(extracted.inputRefs).toEqual([{ txHash: utxo.tx_hash, index: utxo.tx_index }]);
    expect(bytesToHex(extracted.metadataBytes)).toEqual(auxiliaryDataHex);
    const transactionFee = getTransactionFeeFromCbor(fullTxHex);
    expect(transactionFee.toString()).toBe(inspectCmlTransaction(hexToBytes(fullTxHex)).fee);
    const parsedTotalOutput = getTransactionTotalOutputFromCbor(fullTxHex, {
      defaultNetworkId: network.NetworkId,
      defaultIdentifier,
    });
    const inputTokens = multiTokenFromRemote(utxo, network.NetworkId);
    expect(parsedTotalOutput.getDefaultEntry().amount.toString()).toBe(
      inputTokens.getDefaultEntry().amount.minus(transactionFee).toString()
    );
    for (const inputToken of inputTokens.nonDefaultEntries()) {
      expect(parsedTotalOutput.get(inputToken.identifier).amount.toString()).toBe(inputToken.amount.toString());
    }

    const signRequest = new HaskellShelleyTxSignRequest({
      senderUtxos: [],
      unsignedTx: extracted.bodyBytes,
      changeAddr: [],
      metadata: extracted.metadataBytes,
      networkSettingSnapshot: {
        NetworkId: network.NetworkId,
        ChainNetworkId: 1,
        PoolDeposit: new BigNumber('500'),
        KeyDeposit: new BigNumber('500'),
      },
    });
    signRequest.setMetadata(extracted.metadataBytes);
    expect(signRequest.metadata).toEqual(extracted.metadataBytes);
    expect(Array.from(signRequest.self())).toEqual(Array.from(response.txBuilder));
    expect(signRequest.isEqual(response.txBuilder)).toBe(true);
    const serializedSignRequestHex = signRequest.serializedUnsignedTxHex();
    const signRequestSummary = RustModule.WasmScope(Module => {
      const serializedSignRequest = Module.CML.Transaction.from_cbor_hex(serializedSignRequestHex);
      return {
        bodyBytes: serializedSignRequest.body().to_cbor_bytes(),
        metadataBytes: serializedSignRequest.auxiliary_data().to_cbor_bytes(),
        vkeyWitnesses: serializedSignRequest.witness_set().vkeywitnesses(),
      };
    });
    expect(Array.from(signRequestSummary.bodyBytes)).toEqual(Array.from(response.txBuilder));
    expect(bytesToHex(signRequestSummary.metadataBytes)).toEqual(auxiliaryDataHex);
    expect(signRequestSummary.vkeyWitnesses == null).toBe(true);
  });

  it('Should fail due to insufficient funds (no inputs)', () => {
    expect(() =>
      sendAllUnsignedTxFromUtxo(
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
        },
        [],
        new BigNumber(0),
        getSendAllProtocolParams(),
        undefined,
        network.NetworkId
      )
    ).toThrow(NotEnoughMoneyToSendError);
  });

  it('Should fail due to insufficient funds (not enough to cover fees)', () => {
    const sampleUtxos = genSampleUtxos();
    const utxos: Array<RemoteUnspentOutput> = [sampleUtxos[0]];
    expect(() =>
      sendAllUnsignedTxFromUtxo(
        {
          address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'),
        },
        utxos,
        new BigNumber(0),
        getSendAllProtocolParams(),
        undefined,
        network.NetworkId
      )
    ).toThrow(NotEnoughMoneyToSendError);
  });
});

describe('CML connector transaction construction', () => {
  const makeOutput = (address: string, amount: string, assetAmount?: string, assetId: string = testAssetId): any => {
    const values = [{ identifier: defaultIdentifier, networkId: network.NetworkId, amount: new BigNumber(amount) }];
    if (assetAmount != null) values.push({ identifier: assetId, networkId: network.NetworkId, amount: new BigNumber(assetAmount) });
    return {
      address,
      amount: new MultiToken(values, { defaultIdentifier, defaultNetworkId: network.NetworkId }),
    };
  };

  it('builds a required native-script spend with mint, metadata, signer hashes, and serializable body bytes', async () => {
    const utxo = genAddressedUtxos()[3];
    const change = genSampleAdaAddresses()[3];
    const scriptBytes = RustModule.WasmScope(Module => {
      const script = Module.CML.NativeScript.new_script_pubkey(Module.CML.Ed25519KeyHash.from_hex('11'.repeat(28)));
      return { script: script.to_cbor_hex(), hash: script.hash().to_hex() };
    });
    const response = await newAdaUnsignedTxForConnector(
      [makeOutput(change.address, '2000000', '1', `${scriptBytes.hash}.74657374`)],
      [{ policyScript: scriptBytes.script, assetName: '74657374', amount: '1' }],
      { metadata: { '721': '{"version":"1.0","sample":"yes"}' }, nativeScripts: [scriptBytes.script] },
      change,
      [[utxo, { nativeScript: scriptBytes.script }]],
      [],
      new BigNumber(5000000),
      4999990,
      5007200,
      [scriptBytes.hash, change.address],
      {
        linearFeeCoefficient: '44',
        linearFeeConstant: '155381',
        coinsPerUtxoByte: '4310',
        poolDeposit: '500000000',
        keyDeposit: '2000000',
        networkId: network.NetworkId,
      },
      network.NetworkId
    );

    expect(response.txBuilder).toBeInstanceOf(Uint8Array);
    expect(response.senderUtxos).toHaveLength(1);
    const bodySummary = RustModule.WasmScope(Module => {
      const body = Module.CML.TransactionBody.from_cbor_bytes(response.txBuilder);
      const mint = body.mint();
      const outputs = body.outputs();
      const signers = body.required_signers();
      const metadata = body.auxiliary_data_hash();
      return {
        ttl: body.ttl()?.toString(),
        validityStart: body.validity_interval_start()?.toString(),
        fee: body.fee().toString(),
        outputCount: outputs.len(),
        minted: mint?.get(
          Module.CML.ScriptHash.from_hex(scriptBytes.hash),
          Module.CML.AssetName.from_hex('74657374')
        )?.toString(),
        signerCount: signers?.len() ?? 0,
        hasAuxiliaryDataHash: metadata != null,
      };
    });
    expect(bodySummary).toEqual({
      ttl: '5007200',
      validityStart: '4999990',
      fee: expect.any(String),
      outputCount: 2,
      minted: '1',
      signerCount: 2,
      hasAuxiliaryDataHash: true,
    });
  });

  it('keeps the fee above the serialized minimum for two Byron/bootstrap inputs', async () => {
    const [first, second] = [genAddressedUtxos()[0], genAddressedUtxos()[2]];
    const change = genSampleAdaAddresses()[3];
    const protocolParams = {
      linearFeeCoefficient: '44',
      linearFeeConstant: '155381',
      coinsPerUtxoByte: '4310',
      poolDeposit: '500000000',
      keyDeposit: '2000000',
      networkId: network.NetworkId,
    };
    const response = await newAdaUnsignedTxForConnector(
      [makeOutput(change.address, '5000000')],
      [],
      { metadata: {}, nativeScripts: [] },
      change,
      [[first, undefined], [second, undefined]],
      [],
      new BigNumber(5000000),
      null,
      null,
      [],
      protocolParams,
      network.NetworkId
    );

    const feeCheck = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const witnesses = cml.TransactionWitnessSetBuilder.new();
      [first, second].forEach((utxo, index) => {
        const byron = cml.ByronAddress.from_address(cml.Address.from_hex(utxo.receiver));
        const publicKey = new Uint8Array(32);
        publicKey[0] = index + 1;
        const signature = new Uint8Array(64);
        signature[0] = index + 1;
        witnesses.add_bootstrap(cml.BootstrapWitness.new(
          cml.PublicKey.from_bytes(publicKey),
          cml.Ed25519Signature.from_raw_bytes(signature),
          new Uint8Array(32),
          byron.content().addr_attributes()
        ));
      });
      const tx = cml.Transaction.new(
        cml.TransactionBody.from_cbor_bytes(response.txBuilder),
        witnesses.build(),
        true
      );
      return {
        fee: tx.body().fee(),
        minimum: cml.min_fee(
          tx,
          cml.LinearFee.new(44n, 155381n, 0n),
          cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)),
          0n
        ),
        witnessCount: tx.witness_set().bootstrap_witnesses()?.len() ?? 0,
      };
    });
    expect(feeCheck.witnessCount).toEqual(2);
    expect(feeCheck.fee).toBeGreaterThanOrEqual(feeCheck.minimum);
  });

  it('accounts for a supplied Plutus redeemer and its execution units', async () => {
    const change = genSampleAdaAddresses()[3];
    const fixture = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const plutusV1 = cml.PlutusV1Script.from_hex('4e4d01000033222220051200120011');
      const script = cml.PlutusScript.from_v1(plutusV1);
      const datum = cml.PlutusData.from_cbor_hex('01');
      const redeemer = cml.LegacyRedeemer.new(
        cml.RedeemerTag.Spend,
        0n,
        datum,
        cml.ExUnits.new(14000000n, 10000000000n)
      );
      const address = cml.EnterpriseAddress.new(
        network.NetworkId,
        cml.Credential.new_script(script.hash())
      ).to_address();
      return {
        script: plutusV1.to_cbor_hex(),
        datum: datum.to_cbor_hex(),
        redeemer: redeemer.to_cbor_hex(),
        address: address.to_hex(),
      };
    });
    const input = { ...genAddressedUtxos()[3], receiver: fixture.address };
    const response = await newAdaUnsignedTxForConnector(
      [makeOutput(change.address, '5000000')],
      [],
      { metadata: {}, nativeScripts: [] },
      change,
      [[input, { plutusScript: fixture.script, datum: fixture.datum, redeemer: fixture.redeemer }]],
      [],
      new BigNumber(5000000),
      4999990,
      5007200,
      [],
      {
        linearFeeCoefficient: '44',
        linearFeeConstant: '155381',
        coinsPerUtxoByte: '4310',
        poolDeposit: '500000000',
        keyDeposit: '2000000',
        networkId: network.NetworkId,
      },
      network.NetworkId
    );

    const minimumFee = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const body = cml.TransactionBody.from_cbor_bytes(response.txBuilder);
      const witnesses = cml.TransactionWitnessSetBuilder.new();
      witnesses.add_script(cml.Script.new_plutus_v1(cml.PlutusV1Script.from_cbor_hex(fixture.script)));
      witnesses.add_plutus_datum(cml.PlutusData.from_cbor_hex(fixture.datum));
      witnesses.add_redeemer(cml.LegacyRedeemer.from_cbor_hex(fixture.redeemer));
      const tx = cml.Transaction.new(body, witnesses.build(), true);
      return cml.min_fee(
        tx,
        cml.LinearFee.new(44n, 155381n, 0n),
        cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)),
        0n
      );
    });
    const bodyFee = RustModule.WasmScope(Module => Module.CML.TransactionBody.from_cbor_bytes(response.txBuilder).fee());
    expect(bodyFee).toBeGreaterThanOrEqual(minimumFee);
  });

  it('accounts for execution units on multiple Plutus inputs with distinct redeemer indices', async () => {
    const change = genSampleAdaAddresses()[3];
    const fixture = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const plutusV1 = cml.PlutusV1Script.from_hex('4e4d01000033222220051200120011');
      const script = cml.PlutusScript.from_v1(plutusV1);
      const datum = cml.PlutusData.from_cbor_hex('01');
      const address = cml.EnterpriseAddress.new(network.NetworkId, cml.Credential.new_script(script.hash())).to_address();
      return {
        script: plutusV1.to_cbor_hex(),
        datum: datum.to_cbor_hex(),
        address: address.to_hex(),
        redeemers: [
          cml.LegacyRedeemer.new(cml.RedeemerTag.Spend, 0n, datum, cml.ExUnits.new(14000000n, 10000000000n)).to_cbor_hex(),
          cml.LegacyRedeemer.new(cml.RedeemerTag.Spend, 1n, datum, cml.ExUnits.new(28000000n, 20000000000n)).to_cbor_hex(),
        ],
      };
    });
    const inputs = [
      { ...genAddressedUtxos()[3], tx_hash: '01'.repeat(32), tx_index: 0, receiver: fixture.address },
      { ...genAddressedUtxos()[3], tx_hash: '02'.repeat(32), tx_index: 0, receiver: fixture.address },
    ];
    const response = await newAdaUnsignedTxForConnector(
      [makeOutput(change.address, '7000000')],
      [],
      { metadata: {}, nativeScripts: [] },
      change,
      inputs.map((input, index) => [input, {
        plutusScript: fixture.script,
        datum: fixture.datum,
        redeemer: fixture.redeemers[index],
      }]),
      [],
      new BigNumber(5000000),
      null,
      null,
      [],
      {
        linearFeeCoefficient: '44',
        linearFeeConstant: '155381',
        coinsPerUtxoByte: '4310',
        poolDeposit: '500000000',
        keyDeposit: '2000000',
        networkId: network.NetworkId,
      },
      network.NetworkId
    );

    const minimumFee = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const body = cml.TransactionBody.from_cbor_bytes(response.txBuilder);
      const witnesses = cml.TransactionWitnessSetBuilder.new();
      witnesses.add_script(cml.Script.new_plutus_v1(cml.PlutusV1Script.from_cbor_hex(fixture.script)));
      witnesses.add_plutus_datum(cml.PlutusData.from_cbor_hex(fixture.datum));
      fixture.redeemers.forEach(redeemer => witnesses.add_redeemer(cml.LegacyRedeemer.from_cbor_hex(redeemer)));
      const tx = cml.Transaction.new(body, witnesses.build(), true);
      return {
        inputCount: body.inputs().len(),
        fee: body.fee(),
        txSize: tx.to_cbor_bytes().length,
        minimum: cml.min_fee(
          tx,
          cml.LinearFee.new(44n, 155381n, 0n),
          cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)),
          0n
        ),
      };
    });
    expect(minimumFee.inputCount).toBe(2);
    expect(minimumFee.fee).toBeGreaterThanOrEqual(minimumFee.minimum);
    expect(minimumFee.fee).toBeLessThanOrEqual(minimumFee.minimum + 10000n);
  });

  it('covers serialized fees for a mixed native-script and Plutus spend', async () => {
    const change = genSampleAdaAddresses()[3];
    const fixtures = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const nativeScript = cml.NativeScript.new_script_pubkey(cml.Ed25519KeyHash.from_hex('33'.repeat(28)));
      const plutusScript = cml.PlutusV1Script.from_hex('4e4d01000033222220051200120011');
      const plutus = cml.PlutusScript.from_v1(plutusScript);
      const datum = cml.PlutusData.from_cbor_hex('01');
      const redeemer = cml.LegacyRedeemer.new(cml.RedeemerTag.Spend, 0n, datum, cml.ExUnits.new(14000000n, 10000000000n));
      return {
        nativeScript: nativeScript.to_cbor_hex(),
        plutusScript: plutusScript.to_cbor_hex(),
        datum: datum.to_cbor_hex(),
        redeemer: redeemer.to_cbor_hex(),
        plutusAddress: cml.EnterpriseAddress.new(network.NetworkId, cml.Credential.new_script(plutus.hash())).to_address().to_hex(),
      };
    });
    const [plutusInput, nativeInput] = [
      { ...genAddressedUtxos()[3], tx_hash: '03'.repeat(32), receiver: fixtures.plutusAddress },
      { ...genAddressedUtxos()[3], tx_hash: '04'.repeat(32) },
    ];
    const response = await newAdaUnsignedTxForConnector(
      [makeOutput(change.address, '7000000')],
      [],
      { metadata: {}, nativeScripts: [] },
      change,
      [
        [plutusInput, { plutusScript: fixtures.plutusScript, datum: fixtures.datum, redeemer: fixtures.redeemer }],
        [nativeInput, { nativeScript: fixtures.nativeScript }],
      ],
      [],
      new BigNumber(5000000),
      null,
      null,
      [],
      {
        linearFeeCoefficient: '44',
        linearFeeConstant: '155381',
        coinsPerUtxoByte: '4310',
        poolDeposit: '500000000',
        keyDeposit: '2000000',
        networkId: network.NetworkId,
      },
      network.NetworkId
    );

    const feeCheck = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const body = cml.TransactionBody.from_cbor_bytes(response.txBuilder);
      const witnesses = cml.TransactionWitnessSetBuilder.new();
      witnesses.add_script(cml.Script.new_native(cml.NativeScript.from_cbor_hex(fixtures.nativeScript)));
      witnesses.add_script(cml.Script.new_plutus_v1(cml.PlutusV1Script.from_cbor_hex(fixtures.plutusScript)));
      witnesses.add_plutus_datum(cml.PlutusData.from_cbor_hex(fixtures.datum));
      witnesses.add_redeemer(cml.LegacyRedeemer.from_cbor_hex(fixtures.redeemer));
      const tx = cml.Transaction.new(body, witnesses.build(), true);
      return {
        inputCount: body.inputs().len(),
        fee: body.fee(),
        minimum: cml.min_fee(
          tx,
          cml.LinearFee.new(44n, 155381n, 0n),
          cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)),
          0n
        ),
      };
    });
    expect(feeCheck.inputCount).toBe(2);
    expect(feeCheck.fee).toBeGreaterThanOrEqual(feeCheck.minimum);
    expect(feeCheck.fee).toBeLessThanOrEqual(feeCheck.minimum + 10000n);
  });

  it('preserves the insufficient-funds error for a connector input that cannot cover outputs', async () => {
    const change = genSampleAdaAddresses()[3];
    await expect(newAdaUnsignedTxForConnector(
      [makeOutput(change.address, '50000000')],
      [],
      { metadata: {}, nativeScripts: [] },
      change,
      [[genAddressedUtxos()[3], undefined]],
      [],
      new BigNumber(5000000),
      null,
      null,
      [],
      getProtocolParams(),
      network.NetworkId
    )).rejects.toThrow(NotEnoughMoneyToSendError);
  });

  it('preserves native-script burns against the matching input asset', async () => {
    const change = genSampleAdaAddresses()[3];
    const script = RustModule.WasmScope(Module => {
      const value = Module.CML.NativeScript.new_script_pubkey(Module.CML.Ed25519KeyHash.from_hex('22'.repeat(28)));
      return { bytes: value.to_cbor_hex(), policy: value.hash().to_hex() };
    });
    const assetName = '6275726e';
    const assetId = `${script.policy}.${assetName}`;
    const input = {
      ...genAddressedUtxos()[3],
      assets: [{ amount: '1', assetId, policyId: script.policy, name: assetName }],
    };
    const response = await newAdaUnsignedTxForConnector(
      [makeOutput(change.address, '5000000')],
      [{ policyScript: script.bytes, assetName, amount: '-1' }],
      { metadata: {}, nativeScripts: [] },
      change,
      [[input, { nativeScript: script.bytes }]],
      [],
      new BigNumber(5000000),
      null,
      null,
      [],
      getProtocolParams(),
      network.NetworkId
    );
    const burnedAmount = RustModule.WasmScope(Module => {
      const body = Module.CML.TransactionBody.from_cbor_bytes(response.txBuilder);
      return body.mint().get(
        Module.CML.ScriptHash.from_hex(script.policy),
        Module.CML.AssetName.from_hex(assetName)
      ).toString();
    });
    expect(burnedAmount).toEqual('-1');
  });
});

describe('CML maximum send amount', () => {
  it('matches CSL fixed-input fee and change for an ADA-only transaction', async () => {
    const utxo = genSampleUtxos()[3];
    const receiver = genSampleAdaAddresses()[0].address;
    const queriedUtxo = {
      address: utxo.receiver,
      output: {
        tokens: [
          {
            Token: { Identifier: defaultIdentifier },
            TokenList: { Amount: utxo.amount },
          },
        ],
        Transaction: { Hash: utxo.tx_hash },
        UtxoTransactionOutput: { OutputIndex: utxo.tx_index },
      },
    };
    const maxAmount = await maxSendableADA({
      publicDeriver: {
        networkId: network.NetworkId,
        utxos: [queriedUtxo],
        defaultTokenId: defaultIdentifier,
      },
      absSlotNumber: new BigNumber(0),
      tokens: [],
      receiver,
    });

    const cslProtocolParams = getCardanoHaskellBaseConfig(network).reduce((acc, next) => Object.assign(acc, next), {});
    const cslBuilder = RustModule.WalletV4TxBuilder({
      linearFee: RustModule.WalletV4.LinearFee.new(
        RustModule.WalletV4.BigNum.from_str(cslProtocolParams.LinearFee.coefficient),
        RustModule.WalletV4.BigNum.from_str(cslProtocolParams.LinearFee.constant)
      ),
      coinsPerUtxoByte: RustModule.WalletV4.BigNum.from_str(cslProtocolParams.CoinsPerUtxoByte),
      poolDeposit: RustModule.WalletV4.BigNum.zero(),
      keyDeposit: RustModule.WalletV4.BigNum.zero(),
    });
    cslBuilder.set_ttl(7200);
    cslBuilder.add_regular_input(
      RustModule.WalletV4.Address.from_hex(utxo.receiver),
      RustModule.WalletV4.TransactionInput.new(RustModule.WalletV4.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index),
      RustModule.WalletV4.Value.new(RustModule.WalletV4.BigNum.from_str(utxo.amount))
    );
    const cslReceiver = RustModule.WalletV4.Address.from_hex(receiver);
    cslBuilder.add_change_if_needed(cslReceiver);
    const cslOutput = cslBuilder.build().outputs().get(0);
    const cslMaxAmount = new BigNumber(cslOutput.amount().coin().to_str());
    const cslFee = new BigNumber(cslBuilder.min_fee().to_str());

    expect(maxAmount.toString()).toBe(cslMaxAmount.toString());
    expect(new BigNumber(utxo.amount).minus(maxAmount).toString()).toBe(cslFee.toString());
  });
});
