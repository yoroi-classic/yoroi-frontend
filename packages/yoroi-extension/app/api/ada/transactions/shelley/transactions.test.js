// @flow
import '../../lib/test-config.forTests';

import { schema } from 'lovefield';
import BigNumber from 'bignumber.js';
import type { CardanoAddressedUtxo } from '../types';
import type { Address, Addressing, QueriedUtxo } from '../../lib/storage/models/PublicDeriver/interfaces';
import type { RemoteUnspentOutput } from '../../lib/state-fetch/types';
import {
  maxSendableADA,
  newAdaUnsignedTx,
  newAdaUnsignedTxForConnector,
  newAdaUnsignedTxFromUtxo,
  genFilterSmallUtxo,
  isMinimumUtxoValueError,
  sendAllUnsignedTxFromUtxo,
  signTransaction,
  transactionWitnessSetHex,
} from './transactions';
import { AssetOverflowError, NoOutputsError, NotEnoughMoneyToSendError } from '../../../common/errors';

import { loadLovefieldDB } from '../../lib/storage/database/index';
import { Bip44DerivationLevels } from '../../lib/storage/database/walletTypes/bip44/api/utils';
import { byronAddrToHex } from '../../lib/storage/bridge/utils';

import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { CoinTypes, HARD_DERIVATION_START, STAKING_KEY_INDEX, WalletTypePurpose } from '../../../../config/numbersConfig';
import { defaultAssets, networks } from '../../lib/storage/database/prepackaged/networks';
import { MultiToken } from '../../../common/lib/MultiToken';
import {
  cardanoValueFromRemoteFormat,
  getTransactionFeeFromCbor,
  getTransactionTotalOutputFromCbor,
  identifierSplit,
  multiTokenFromRemote,
} from '../utils';
import { getStakingKeyHashesInTransactionBody } from '../../lib/cardanoCrypto/utils';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';
import { createCertificate } from '../../lib/storage/bridge/delegationUtils';
import { createMetadata } from '../../lib/storage/bridge/metadataUtils';
import { extractSwapCmlTransaction } from '../../../../stores/ada/swapCmlTx';
import { HaskellShelleyTxSignRequest } from './HaskellShelleyTxSignRequest';

const network = networks.CardanoMainnet;
const defaultIdentifier = defaultAssets.filter(asset => asset.NetworkId === network.NetworkId)[0].Identifier;

const testAssetId = 'd27197682d71905c087c5c3b61b10e6d746db0b9bef351014d75bb26.6e69636f696e';

function bech32ToHex(s: string): string {
  return RustModule.WasmScope(Module => Module.CML.Address.from_bech32(s).to_hex());
}

function inspectCmlTransaction(bytes: Uint8Array): any {
  return RustModule.WasmScope(Module => {
    const transaction = Module.CML.Transaction.from_cbor_bytes(bytes);
    const body = transaction.body();
    const witnesses = transaction.witness_set();
    const certificates = body.certs();
    const vkeyWitnesses = witnesses.vkeywitnesses();
    return {
      certificatesHex:
        certificates == null
          ? undefined
          : Array.from({ length: certificates.len() }, (_, index) => bytesToHex(certificates.get(index).to_cbor_bytes())),
      withdrawalCount: body.withdrawals()?.len() ?? 0,
      fee: body.fee().toString(),
      outputCount: body.outputs().len(),
      outputCoinTotal: Array.from(
        { length: body.outputs().len() },
        (_, index) => new BigNumber(body.outputs().get(index).amount().coin().toString())
      )
        .reduce((total, amount) => total.plus(amount), new BigNumber(0))
        .toString(),
      finalOutputCoin: body
        .outputs()
        .get(body.outputs().len() - 1)
        .amount()
        .coin()
        .toString(),
      vkeyWitnessCount: vkeyWitnesses?.len() ?? 0,
      plutusDatumCount: witnesses.plutus_datums()?.len() ?? 0,
      plutusDatumHex: witnesses.plutus_datums()?.get(0)?.to_cbor_hex(),
      witnessSetHex: witnesses.to_cbor_hex(),
      vkeyHashes:
        vkeyWitnesses == null
          ? []
          : Array.from({ length: vkeyWitnesses.len() }, (_, index) => vkeyWitnesses.get(index).vkey().hash().to_hex()),
      hasNativeScripts: witnesses.native_scripts() != null,
      hasBootstrapWitnesses: witnesses.bootstrap_witnesses() != null,
    };
  });
}

function inspectCmlBody(bytes: Uint8Array): {|
  auxiliaryDataHash: ?string,
  fee: string,
  inputCount: number,
  outputTotal: string,
  outputs: Array<string>,
|} {
  return RustModule.WasmScope(Module => {
    const body = Module.CML.TransactionBody.from_cbor_bytes(bytes);
    const outputs = body.outputs();
    const outputCoins = Array.from({ length: outputs.len() }, (_, index) => outputs.get(index).amount().coin());
    return {
      fee: body.fee().toString(),
      auxiliaryDataHash: body.auxiliary_data_hash()?.to_hex(),
      inputCount: body.inputs().len(),
      outputTotal: outputCoins.reduce((sum, coin) => sum + coin, BigInt('0')).toString(),
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

test('recognizes CML minimum UTxO errors including its reported spelling', () => {
  expect(isMinimumUtxoValueError(new Error('Value 500000 less tan the minimum UTXO value 969750'))).toBe(true);
  expect(isMinimumUtxoValueError(new Error('Value 500000 less than the minimum UTXO value 969750'))).toBe(true);
  expect(isMinimumUtxoValueError(new Error('Insufficient funds'))).toBe(false);
});

describe('Create unsigned TX from UTXO', () => {
  it('preserves ADA change and charges only the transaction fee', async () => {
    const utxo = { ...genSampleUtxos()[0], amount: '10000000', assets: [] };
    const [changeAddress] = genSampleAdaAddresses();
    const output = new MultiToken(
      [{ amount: new BigNumber(5000000), identifier: defaultIdentifier, networkId: network.NetworkId }],
      { defaultIdentifier, defaultNetworkId: network.NetworkId }
    );
    const result = await newAdaUnsignedTxFromUtxo(
      [{ address: byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4'), amount: output }],
      changeAddress,
      [utxo],
      new BigNumber(0),
      getProtocolParams(),
      [],
      [],
      true,
      undefined,
      network.NetworkId
    );
    const body = inspectCmlBody(result.txBuilder);
    expect(body.outputs).toHaveLength(2);
    expect(new BigNumber(body.fee).lt(500000)).toBe(true);
    expect(
      new BigNumber(utxo.amount).minus(body.outputs.reduce((sum, amount) => sum.plus(amount), new BigNumber(0))).toString()
    ).toBe(body.fee);
  });

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
      expect(unsignedTxResponse.senderUtxos.length).toBeLessThan(4);
      const inputTotal = unsignedTxResponse.senderUtxos.reduce((total, utxo) => total.plus(utxo.amount), new BigNumber(0));
      const outputTotal = body.outputs.reduce((total, amount) => total.plus(amount), new BigNumber(0));
      expect(inputTotal.minus(outputTotal).toString()).toBe(body.fee);
      expect(new Set(unsignedTxResponse.senderUtxos.map(utxo => utxo.utxo_id)).size).toBe(unsignedTxResponse.senderUtxos.length);
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
    expect(new Set(unsignedTxResponse.senderUtxos.map(utxo => utxo.utxo_id)).size).toBe(unsignedTxResponse.senderUtxos.length);
    expect(selectedAda.minus(outputAda).toString()).toBe(body.fee);
    expect(inspectCmlAssetAmounts(unsignedTxResponse.txBuilder, testAssetId).sort()).toEqual(['1000', '234']);
  });

  it('extracts witnesses from the serialized CML transaction returned by the signer', () => {
    const signedTransactionBytes = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const body = cml.TransactionBody.from_cbor_hex('a3008001800200');
      const witnesses = cml.TransactionWitnessSet.new();
      return cml.Transaction.new(body, witnesses, true).to_cbor_bytes();
    });

    const witnessSetHex = transactionWitnessSetHex(signedTransactionBytes);

    expect(witnessSetHex).toBe(RustModule.WasmScope(Module => Module.CML.TransactionWitnessSet.new().to_cbor_hex()));
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
          amount: new BigNumber(9000000),
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

  it('adds another UTxO when selected change is below minimum ADA', async () => {
    const utxos = [
      { ...genSampleUtxos()[2], amount: '10000000' },
      { ...genSampleUtxos()[3], amount: '3000000' },
    ];
    const output = new MultiToken(
      [
        {
          amount: new BigNumber(9800000),
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
      genSampleAdaAddresses()[0],
      utxos,
      new BigNumber(0),
      { ...getProtocolParams(), coinsPerUtxoByte: '4310' },
      [],
      [],
      true,
      undefined,
      network.NetworkId
    );

    const body = inspectCmlBody(result.txBuilder);
    expect(result.senderUtxos).toHaveLength(2);
    expect(body.inputCount).toBe(2);
    expect(new BigNumber(body.fee).lt(200000)).toBe(true);
    expect(new BigNumber(body.outputs[1]).gt(1000000)).toBe(true);
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
    expect(new BigNumber(addressedUtxos[1].amount).minus(body.outputs[0]).toString()).toEqual(body.fee);
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

    const accountPrivateKey = RustModule.CML.Bip32PrivateKey.from_raw_bytes(
      hexToBytes(
        '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d'
      )
    );
    const signedTx = signTransaction(
      unsignedTxResponse.senderUtxos,
      unsignedTxResponse.txBuilder,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey.to_raw_bytes(),
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
        .getDefaultEntry()
        .amount.toString()
    ).toBe(cmlSummary.outputCoinTotal);
  });

  it('Witness should with addressing from root', () => {
    const accountPrivateKey = RustModule.CML.Bip32PrivateKey.from_raw_bytes(
      hexToBytes(
        '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d'
      )
    );
    const txBodyBytes = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const inputs = cml.TransactionInputList.new();
      inputs.add(
        cml.TransactionInput.new(
          cml.TransactionHash.from_hex('05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f'),
          BigInt('0')
        )
      );
      inputs.add(
        cml.TransactionInput.new(
          cml.TransactionHash.from_hex('6930f123df83e4178b0324ae617b2028c0b38c6ff4660583a2abf1f7b08195fe'),
          BigInt('0')
        )
      );
      const outputs = cml.TransactionOutputList.new();
      outputs.add(
        cml.TransactionOutput.new(
          cml.Address.from_hex(byronAddrToHex('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4')),
          cml.Value.new(BigInt('5001'), cml.MultiAsset.new())
        )
      );
      const body = cml.TransactionBody.new(inputs, outputs, BigInt('1000'));
      body.set_ttl(BigInt('0'));
      return body.to_cbor_bytes();
    });
    const bodyCompatibility = RustModule.WasmScope(Module => {
      const body = Module.CML.TransactionBody.from_cbor_bytes(txBodyBytes);
      return {
        ttl: body.ttl()?.toString(),
        hash: Module.CML.hash_transaction(body).to_hex(),
      };
    });
    expect(bodyCompatibility).toEqual({ ttl: '0', hash: 'bac9f1ec48694482149a9963c8b2fc3e7e7406a72b7d0942f201b7562f2c8da5' });

    const senderUtxos = [
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
    ];
    const firstSignedTx = signTransaction(
      senderUtxos,
      txBodyBytes,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey.to_raw_bytes(),
      null,
      undefined
    );
    const existingWitnessSet = RustModule.WasmScope(Module =>
      Module.CML.Transaction.from_cbor_bytes(firstSignedTx).witness_set().to_cbor_bytes()
    );
    const signedTx = signTransaction(
      senderUtxos,
      txBodyBytes,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey.to_raw_bytes(),
      null,
      undefined,
      [],
      existingWitnessSet
    );
    const bootstrapWitnesses = RustModule.WasmScope(Module => {
      const witnessSet = Module.CML.Transaction.from_cbor_bytes(signedTx).witness_set();
      const bootstraps = witnessSet.bootstrap_witnesses();
      const bootstrap = bootstraps?.get(0);
      if (bootstrap == null) throw new Error('Missing bootstrap witness');
      const bodyHash = Module.CML.hash_transaction(Module.CML.Transaction.from_cbor_bytes(signedTx).body());
      return {
        vkeyCount: witnessSet.vkeywitnesses()?.len() ?? 0,
        nativeScriptCount: witnessSet.native_scripts()?.len() ?? 0,
        bootstrapHex: bootstrap?.to_cbor_hex(),
        signatureValid: bootstrap.public_key().verify(bodyHash.to_raw_bytes(), bootstrap.signature()),
        chainCodeLength: bootstrap?.chain_code().length,
        attributesHex: bootstrap?.attributes().to_cbor_hex(),
        bootstrapCount: bootstraps?.len() ?? 0,
      };
    });

    expect(bootstrapWitnesses.vkeyCount).toEqual(0);
    expect(bootstrapWitnesses.nativeScriptCount).toEqual(0);
    expect(bootstrapWitnesses.bootstrapCount).toEqual(1); // note: only one witness since we got rid of duplicates
    expect(bootstrapWitnesses.signatureValid).toBe(true);
    expect(bootstrapWitnesses.chainCodeLength).toBe(32);
    expect(bootstrapWitnesses.attributesHex).toBe('a0');

    expect(bootstrapWitnesses.bootstrapHex).toEqual(
      '8458208fb03c3aa052f51c086c54bd4059ead2d2e426ac89fa4b3ce41cbfd8800b51c05840593e3d54a9bf9b5e6778ddb8930bdd9a87dd29f046fa3ba9d49bd1b7ddecdb6a1ced6016cdab663ff21596380392786d67f70e8d7c200fc042d669981db11c0658202623fceb96b07408531a5cb259f53845a38d6b68928e7c0c7e390f07545d0e6241a0'
    );
  });

  it('does not duplicate vkey witnesses from wallet and stake signing', () => {
    const accountPrivateKey = RustModule.CML.Bip32PrivateKey.from_raw_bytes(
      hexToBytes(
        '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d'
      )
    );
    const paymentKey = accountPrivateKey.derive(0).derive(0);
    const { bodyBytes, senderUtxo, requiredSigners, keyHash } = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const paymentKeyHash = paymentKey.to_public().to_raw_key().hash();
      const credential = cml.Credential.new_pub_key(paymentKeyHash);
      const address = cml.EnterpriseAddress.new(network.NetworkId, credential).to_address();
      const rewardAddress = cml.RewardAddress.new(network.NetworkId, credential).to_address();
      const inputHash = cml.TransactionHash.from_hex('05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f');
      const inputs = cml.TransactionInputList.new();
      inputs.add(cml.TransactionInput.new(inputHash, BigInt('0')));
      const outputs = cml.TransactionOutputList.new();
      outputs.add(cml.TransactionOutput.new(address, cml.Value.new(BigInt('2000000'), cml.MultiAsset.new())));
      const body = cml.TransactionBody.new(inputs, outputs, BigInt('1000'));
      const certificates = cml.CertificateList.new();
      certificates.add(cml.Certificate.new_stake_registration(credential));
      body.set_certs(certificates);
      return {
        bodyBytes: body.to_cbor_bytes(),
        senderUtxo: {
          amount: '3000000',
          assets: [],
          addressing: { path: [0, 0], startLevel: Bip44DerivationLevels.CHAIN.level },
          receiver: address.to_hex(),
          tx_hash: '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f',
          tx_index: 0,
          utxo_id: '05ec4a4a7f4645fa66886cef2e34706907a3a7f9d88e0d48b313ad2cdf76fb5f0',
        },
        requiredSigners: [
          {
            address: rewardAddress.to_hex(),
            addressing: { path: [0, 0], startLevel: Bip44DerivationLevels.CHAIN.level },
          },
        ],
        keyHash: paymentKeyHash.to_hex(),
      };
    });
    const firstSignature = signTransaction(
      [senderUtxo],
      bodyBytes,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey.to_raw_bytes(),
      null,
      undefined,
      requiredSigners
    );
    const existingWitnessSet = RustModule.WasmScope(Module =>
      Module.CML.Transaction.from_cbor_bytes(firstSignature).witness_set().to_cbor_bytes()
    );

    const signedTransaction = signTransaction(
      [senderUtxo],
      bodyBytes,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey.to_raw_bytes(),
      paymentKey.to_raw_key().to_raw_bytes(),
      undefined,
      requiredSigners,
      existingWitnessSet
    );

    expect(inspectCmlTransaction(signedTransaction)).toMatchObject({
      vkeyWitnessCount: 1,
      vkeyHashes: [keyHash],
    });
  });

  it('Transaction should support certificates', async () => {
    const accountPrivateKey = RustModule.CML.Bip32PrivateKey.from_raw_bytes(
      hexToBytes(
        '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247'
      )
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
      createCertificate(
        stakingKey.to_public().hash().to_hex(),
        false,
        '1b268f4cba3faa7e36d8a0cc4adca2096fb856119412ee7330f692b5',
        undefined
      ),
      [],
      true,
      undefined,
      network.NetworkId
    );
    const expectedCertificateHex = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const stakeCredential = cml.Credential.new_pub_key(stakingKey.to_public().hash());
      const certificates = cml.CertificateList.new();
      certificates.add(cml.Certificate.new_stake_registration(stakeCredential));
      certificates.add(
        cml.Certificate.new_stake_delegation(
          stakeCredential,
          cml.Ed25519KeyHash.from_hex('1b268f4cba3faa7e36d8a0cc4adca2096fb856119412ee7330f692b5')
        )
      );
      return Array.from({ length: certificates.len() }, (_, index) => bytesToHex(certificates.get(index).to_cbor_bytes()));
    });
    const certificateInfo = inspectCmlTransaction(
      RustModule.WasmScope(Module =>
        Module.CML.Transaction.new(
          Module.CML.TransactionBody.from_cbor_bytes(unsignedTxResponse.txBuilder),
          Module.CML.TransactionWitnessSet.new(),
          true
        ).to_cbor_bytes()
      )
    );
    expect(certificateInfo.certificatesHex).toEqual(expectedCertificateHex);
    const signedTx = signTransaction(
      unsignedTxResponse.senderUtxos,
      unsignedTxResponse.txBuilder,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey.to_raw_bytes(),
      stakingKey.to_raw_bytes(),
      undefined
    );
    const signedInfo = inspectCmlTransaction(signedTx);
    expect(getTransactionFeeFromCbor(bytesToHex(signedTx)).toString()).toBe(signedInfo.fee);
    expect(
      getTransactionTotalOutputFromCbor(bytesToHex(signedTx), { defaultIdentifier, defaultNetworkId: network.NetworkId })
        .getDefaultEntry()
        .amount.toString()
    ).toBe(signedInfo.outputCoinTotal);
    expect(signedInfo.vkeyWitnessCount).toEqual(2);
    expect(signedInfo.hasNativeScripts).toEqual(false);
    expect(signedInfo.hasBootstrapWitnesses).toEqual(false);
  });

  it('Transaction should support withdrawals', async () => {
    const accountPrivateKey = RustModule.CML.Bip32PrivateKey.from_raw_bytes(
      hexToBytes(
        '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247'
      )
    );
    const stakingKey = accountPrivateKey.derive(2).derive(STAKING_KEY_INDEX).to_raw_key();
    const stakingKeyHash = stakingKey.to_public().hash().to_hex();

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
      createCertificate(stakingKeyHash, true, undefined, undefined),
      [
        {
          address: RustModule.WasmScope(Module =>
            Module.CML.RewardAddress.new(
              Number.parseInt(network.BaseConfig[0].ChainNetworkId, 10),
              Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stakingKeyHash))
            )
              .to_address()
              .to_hex()
          ),
          amount: withdrawAmount,
        },
      ],
      true,
      undefined,
      network.NetworkId
    );

    const expectedCertificateHex = RustModule.WasmScope(Module => {
      const credential = Module.CML.Credential.new_pub_key(stakingKey.to_public().hash());
      const certificate = Module.CML.Certificate.new_stake_deregistration(credential);
      return [bytesToHex(certificate.to_cbor_bytes())];
    });
    const unsignedInfo = inspectCmlTransaction(
      RustModule.WasmScope(Module =>
        Module.CML.Transaction.new(
          Module.CML.TransactionBody.from_cbor_bytes(unsignedTxResponse.txBuilder),
          Module.CML.TransactionWitnessSet.new(),
          true
        ).to_cbor_bytes()
      )
    );
    const cmlReserializedBodyHex = RustModule.WasmScope(Module =>
      bytesToHex(Module.CML.TransactionBody.from_cbor_bytes(unsignedTxResponse.txBuilder).to_cbor_bytes())
    );
    expect(getStakingKeyHashesInTransactionBody(bytesToHex(unsignedTxResponse.txBuilder)).has(stakingKeyHash)).toBe(true);
    expect(getStakingKeyHashesInTransactionBody(cmlReserializedBodyHex).has(stakingKeyHash)).toBe(true);
    expect(
      RustModule.WasmScope(Module =>
        Module.CML.PrivateKey.from_extended_bytes(stakingKey.to_raw_bytes()).to_public().hash().to_hex()
      )
    ).toBe(stakingKeyHash);
    const expectedPaymentHashes = unsignedTxResponse.senderUtxos.map(utxo => {
      let derived = accountPrivateKey;
      const firstPathIndex = Bip44DerivationLevels.ACCOUNT.level - utxo.addressing.startLevel + 1;
      for (let i = firstPathIndex; i < utxo.addressing.path.length; i++) derived = derived.derive(utxo.addressing.path[i]);
      return derived.to_raw_key().to_public().hash().to_hex();
    });
    expect(unsignedInfo.certificatesHex).toEqual(expectedCertificateHex);

    const signedTx = signTransaction(
      unsignedTxResponse.senderUtxos,
      unsignedTxResponse.txBuilder,
      Bip44DerivationLevels.ACCOUNT.level,
      accountPrivateKey.to_raw_bytes(),
      stakingKey.to_raw_bytes(),
      undefined
    );
    const signedInfo = inspectCmlTransaction(signedTx);
    expect(getTransactionFeeFromCbor(bytesToHex(signedTx)).toString()).toBe(signedInfo.fee);
    expect(
      getTransactionTotalOutputFromCbor(bytesToHex(signedTx), { defaultIdentifier, defaultNetworkId: network.NetworkId })
        .getDefaultEntry()
        .amount.toString()
    ).toBe(signedInfo.outputCoinTotal);
    expect(expectedPaymentHashes).toHaveLength(1);
    expect(unsignedTxResponse.senderUtxos).toHaveLength(1);
    expect(signedInfo.vkeyHashes).toContain(expectedPaymentHashes[0]);
    expect(signedInfo.vkeyHashes).toContain(stakingKeyHash);
    expect(signedInfo.vkeyWitnessCount).toEqual(2);
    expect(signedInfo.hasNativeScripts).toEqual(false);
    expect(signedInfo.hasBootstrapWitnesses).toEqual(false);
    expect(unsignedInfo.withdrawalCount).toEqual(1);
    const fee = unsignedInfo.fee;
    expect(new BigNumber(fee).gt(0)).toBe(true);
    expect(unsignedInfo.outputCount).toEqual(1);
    expect(unsignedInfo.finalOutputCoin).toEqual(
      new BigNumber(withdrawAmount)
        .plus(unsignedTxResponse.senderUtxos.reduce((sum, utxo) => sum.plus(utxo.amount), new BigNumber(0)))
        .plus(protocolParams.keyDeposit)
        .minus(fee)
        .toString()
    );
  });
});

describe('Create sendAll unsigned TX from UTXO', () => {
  it('matches the CML minimum-input fee cutoff for Shelley and Byron addresses', () => {
    const protocolParams = getSendAllProtocolParams();
    const cmlFilter = genFilterSmallUtxo({
      protocolParams: {
        linearFeeCoefficient: protocolParams.linearFeeCoefficient,
        linearFeeConstant: protocolParams.linearFeeConstant,
      },
    });
    for (const source of [genSampleUtxos()[1], genSampleUtxos()[3], genSampleUtxos()[4]]) {
      if (source == null) throw new Error('Missing UTxO fixture');
      const utxo = {
        ...source,
        amount: '0',
      };
      const fee = RustModule.WasmScope(Module => {
        const cml = Module.CML;
        const config = cml.TransactionBuilderConfigBuilder.new()
          .fee_algo(
            cml.LinearFee.new(
              // eslint-disable-next-line no-undef
              BigInt(protocolParams.linearFeeCoefficient),
              // eslint-disable-next-line no-undef
              BigInt(protocolParams.linearFeeConstant),
              BigInt('0')
            )
          )
          .coins_per_utxo_byte(BigInt('0'))
          .pool_deposit(BigInt('0'))
          .key_deposit(BigInt('0'))
          .max_value_size(5000)
          .max_tx_size(16384)
          .ex_unit_prices(
            cml.ExUnitPrices.new(
              cml.Rational.new(BigInt('577'), BigInt('10000')),
              cml.Rational.new(BigInt('721'), BigInt('10000000'))
            )
          )
          .collateral_percentage(150)
          .max_collateral_inputs(3)
          .build();
        const builder = cml.TransactionBuilder.new(config);
        // eslint-disable-next-line no-undef
        const input = cml.TransactionInput.new(cml.TransactionHash.from_hex(utxo.tx_hash), BigInt(utxo.tx_index));
        const output = cml.TransactionOutput.new(cml.Address.from_hex(utxo.receiver), cardanoValueFromRemoteFormat(utxo));
        return builder.fee_for_input(cml.SingleInputBuilder.new(input, output).payment_key()).toString();
      });
      expect(cmlFilter({ ...utxo, amount: fee })).toBe(true);
      expect(cmlFilter({ ...utxo, amount: new BigNumber(fee).minus(1).toString() })).toBe(false);
    }
  });

  describe('Create send-all TX from UTXO', () => {
    it('Create a transaction involving all input with no change', () => {
      const sampleUtxos = genSampleUtxos();
      const utxos: Array<RemoteUnspentOutput> = [sampleUtxos[1], sampleUtxos[2]];
      const changeAddress = genSampleAdaAddresses()[0];
      if (changeAddress == null) throw new Error('Missing change address fixture');
      const addressedChangeAddress = {
        ...changeAddress,
        addressing: changeAddress.addressing ?? { path: [0, 0], startLevel: 0 },
      };
      const metadata = createMetadata([{ label: '0', data: { value: 1 } }]);
      const sendAllResponse = sendAllUnsignedTxFromUtxo(
        addressedChangeAddress,
        utxos,
        new BigNumber(0),
        getSendAllProtocolParams(),
        metadata,
        network.NetworkId
      );

      const expectedInput = new BigNumber('11000002');
      expect(sendAllResponse.senderUtxos).toEqual([utxos[0], utxos[1]]);
      const body = inspectCmlBody(sendAllResponse.txBuilder);
      expect(body.inputCount).toBe(2);
      expect(expectedInput.minus(body.outputTotal).toString()).toBe(body.fee);
      expect(new BigNumber(body.fee).gt(0)).toBe(true);
      const auxiliaryDataHash = RustModule.WasmScope(Module =>
        Module.CML.hash_auxiliary_data(Module.CML.AuxiliaryData.from_cbor_bytes(metadata)).to_hex()
      );
      expect(body.auxiliaryDataHash).toBe(auxiliaryDataHash);
      expect(sendAllResponse.changeAddr).toHaveLength(1);
      expect(sendAllResponse.changeAddr[0].address).toBe(changeAddress.address);
      expect(sendAllResponse.changeAddr[0].values.getDefaultEntry().amount.toString()).toBe(body.outputs[0]);
    });
  });

  it('extracts swap body, inputs, and metadata with CML', () => {
    const utxo = genSampleUtxos()[1];
    const receiverFixture = genSampleAdaAddresses()[0];
    if (utxo == null || receiverFixture == null) throw new Error('Missing send-all fixture');
    const receiver = {
      ...receiverFixture,
      addressing: receiverFixture.addressing ?? { path: [0, 0], startLevel: 0 },
    };
    const metadata = createMetadata([{ label: '0', data: { value: 4 } }]);
    const response = sendAllUnsignedTxFromUtxo(
      receiver,
      [utxo],
      new BigNumber(0),
      getSendAllProtocolParams(),
      metadata,
      network.NetworkId
    );
    const { fullTxHex, auxiliaryDataHex, scriptDataHashHex, sourceBodyBytes, witnessSetBytes } = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const body = cml.TransactionBody.from_cbor_bytes(response.txBuilder);
      const auxiliaryData = cml.AuxiliaryData.from_cbor_bytes(metadata);
      const sourceAuxiliaryDataHex = auxiliaryData.to_cbor_hex();
      const sourceWitnessSetBytes = Uint8Array.from([0xa1, 0x04, 0x9f, 0x01, 0xff]);
      const sourceWitnessSet = cml.TransactionWitnessSet.from_cbor_bytes(sourceWitnessSetBytes);
      const scriptDataHash = cml.hash_script_data(
        cml.Redeemers.from_cbor_hex('80'),
        cml.CostModels.from_cbor_hex('a0'),
        sourceWitnessSet.plutus_datums()
      );
      body.set_script_data_hash(scriptDataHash);
      const bodyBytes = body.to_cbor_bytes();
      const auxiliaryDataBytes = auxiliaryData.to_cbor_bytes();
      const fullTxBytes = new Uint8Array(1 + bodyBytes.length + sourceWitnessSetBytes.length + 1 + auxiliaryDataBytes.length);
      let offset = 0;
      fullTxBytes[offset++] = 0x84;
      fullTxBytes.set(bodyBytes, offset);
      offset += bodyBytes.length;
      fullTxBytes.set(sourceWitnessSetBytes, offset);
      offset += sourceWitnessSetBytes.length;
      fullTxBytes[offset++] = 0xf5;
      fullTxBytes.set(auxiliaryDataBytes, offset);
      return {
        fullTxHex: bytesToHex(fullTxBytes),
        auxiliaryDataHex: sourceAuxiliaryDataHex,
        scriptDataHashHex: scriptDataHash.to_hex(),
        sourceBodyBytes: bodyBytes,
        witnessSetBytes: sourceWitnessSetBytes,
      };
    });

    const extracted = extractSwapCmlTransaction(fullTxHex);
    expect(Array.from(extracted.bodyBytes)).toEqual(Array.from(sourceBodyBytes));
    expect(extracted.inputRefs).toEqual([{ txHash: utxo.tx_hash, index: utxo.tx_index }]);
    expect(bytesToHex(extracted.metadataBytes)).toEqual(auxiliaryDataHex);
    expect(Array.from(extracted.witnessSetBytes)).toEqual(Array.from(witnessSetBytes));
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
      const parsedTokenAmount = parsedTotalOutput.get(inputToken.identifier);
      if (parsedTokenAmount == null) throw new Error('Missing parsed token amount');
      expect(parsedTokenAmount.toString()).toBe(inputToken.amount.toString());
    }
    if (extracted.metadataBytes == null) throw new Error('Missing extracted metadata');

    const signRequest = new HaskellShelleyTxSignRequest({
      senderUtxos: [],
      unsignedTx: extracted.bodyBytes,
      witnessSet: extracted.witnessSetBytes,
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
    expect(Array.from(signRequest.self())).toEqual(Array.from(extracted.bodyBytes));
    expect(signRequest.isEqual(extracted.bodyBytes)).toBe(true);
    const serializedSignRequestHex = signRequest.serializedUnsignedTxHex();
    const signRequestSummary = RustModule.WasmScope(Module => {
      const serializedSignRequest = Module.CML.Transaction.from_cbor_hex(serializedSignRequestHex);
      const serializedAuxiliaryData = serializedSignRequest.auxiliary_data();
      if (serializedAuxiliaryData == null) throw new Error('Missing serialized auxiliary data');
      return {
        bodyBytes: serializedSignRequest.body().to_cbor_bytes(),
        scriptDataHashHex: serializedSignRequest.body().script_data_hash()?.to_hex(),
        metadataBytes: serializedAuxiliaryData.to_cbor_bytes(),
        vkeyWitnesses: serializedSignRequest.witness_set().vkeywitnesses(),
        plutusDatumCount: serializedSignRequest.witness_set().plutus_datums()?.len() ?? 0,
        plutusDatumHex: serializedSignRequest.witness_set().plutus_datums()?.get(0)?.to_cbor_hex(),
        witnessSetHex: serializedSignRequest.witness_set().to_cbor_hex(),
      };
    });
    expect(Array.from(signRequestSummary.bodyBytes)).toEqual(Array.from(extracted.bodyBytes));
    expect(signRequestSummary.scriptDataHashHex).toBe(scriptDataHashHex);
    expect(bytesToHex(signRequestSummary.metadataBytes)).toEqual(auxiliaryDataHex);
    expect(signRequestSummary.vkeyWitnesses == null).toBe(true);
    expect(signRequestSummary.plutusDatumCount).toBe(1);
    expect(signRequestSummary.plutusDatumHex).toBe('01');
    expect(signRequestSummary.witnessSetHex).toContain('049f01ff');

    const privateKeyBytes = RustModule.WasmScope(Module => {
      const key = Module.CML.Bip32PrivateKey.from_raw_bytes(
        hexToBytes(
          '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d'
        )
      );
      return Array.from(key.to_raw_bytes());
    });
    const signedTransaction = signTransaction(
      [],
      extracted.bodyBytes,
      Bip44DerivationLevels.ACCOUNT.level,
      Uint8Array.from(privateKeyBytes),
      null,
      extracted.metadataBytes,
      [],
      extracted.witnessSetBytes
    );
    expect(inspectCmlTransaction(signedTransaction)).toMatchObject({
      plutusDatumCount: 1,
      plutusDatumHex: '01',
      witnessSetHex: expect.stringContaining('049f01ff'),
    });
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
    if (assetAmount != null)
      values.push({ identifier: assetId, networkId: network.NetworkId, amount: new BigNumber(assetAmount) });
    return {
      address,
      amount: new MultiToken(values, { defaultIdentifier, defaultNetworkId: network.NetworkId }),
    };
  };

  it('builds a required native-script spend with mint, metadata, signer hashes, and serializable body bytes', async () => {
    const utxo = genAddressedUtxos()[3];
    const change = genSampleAdaAddresses()[3];
    if (utxo == null || change == null) throw new Error('Missing connector output fixtures');
    const scriptBytes = RustModule.WasmScope(Module => {
      const script = Module.CML.NativeScript.new_script_pubkey(Module.CML.Ed25519KeyHash.from_hex('11'.repeat(28)));
      const outputReferenceScript = Module.CML.Script.new_native(
        Module.CML.NativeScript.new_script_pubkey(Module.CML.Ed25519KeyHash.from_hex('22'.repeat(28)))
      );
      const datum = Module.CML.PlutusData.new_integer(Module.CML.BigInteger.from_str('42'));
      return {
        script: script.to_cbor_hex(),
        hash: script.hash().to_hex(),
        outputReferenceScript: outputReferenceScript.to_cbor_hex(),
        outputDatum: datum.to_cbor_hex(),
      };
    });
    const response = await newAdaUnsignedTxForConnector(
      [
        {
          ...makeOutput(change.address, '2000000', '1', `${scriptBytes.hash}.74657374`),
          data: scriptBytes.outputDatum,
          referenceScript: scriptBytes.outputReferenceScript,
        },
      ],
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
    const responseAuxiliaryData = response.auxiliaryData;
    if (responseAuxiliaryData == null) throw new Error('Missing connector auxiliary data');
    expect(response.senderUtxos).toHaveLength(1);
    const bodySummary = RustModule.WasmScope(Module => {
      const body = Module.CML.TransactionBody.from_cbor_bytes(response.txBuilder);
      const mint = body.mint();
      const outputs = body.outputs();
      const firstOutput = outputs.get(0);
      if (firstOutput == null) throw new Error('Missing connector output');
      const signers = body.required_signers();
      const metadata = body.auxiliary_data_hash();
      return {
        ttl: body.ttl()?.toString(),
        validityStart: body.validity_interval_start()?.toString(),
        fee: body.fee().toString(),
        outputCount: outputs.len(),
        inlineDatum: firstOutput.datum()?.as_datum()?.to_cbor_hex(),
        referenceScript: firstOutput.script_ref()?.to_cbor_hex(),
        minted: (() => {
          const amount = mint?.get(Module.CML.ScriptHash.from_hex(scriptBytes.hash), Module.CML.AssetName.from_hex('74657374'));
          return amount?.toString();
        })(),
        signerCount: signers?.len() ?? 0,
        hasAuxiliaryDataHash: metadata != null,
      };
    });
    expect(bodySummary).toEqual({
      ttl: '5007200',
      validityStart: '4999990',
      fee: expect.any(String),
      outputCount: 2,
      inlineDatum: scriptBytes.outputDatum,
      referenceScript: scriptBytes.outputReferenceScript,
      minted: '1',
      signerCount: 2,
      hasAuxiliaryDataHash: true,
    });
    const expectedAuxiliaryDataHash = RustModule.WasmScope(Module =>
      Module.CML.hash_auxiliary_data(Module.CML.AuxiliaryData.from_cbor_bytes(responseAuxiliaryData)).to_hex()
    );
    const serializedUnsignedTx = new HaskellShelleyTxSignRequest({
      senderUtxos: [],
      unsignedTx: response.txBuilder,
      witnessSet: response.witnessSet,
      changeAddr: [],
      metadata: response.auxiliaryData,
      networkSettingSnapshot: {
        NetworkId: network.NetworkId,
        ChainNetworkId: 1,
        PoolDeposit: new BigNumber('500000000'),
        KeyDeposit: new BigNumber('2000000'),
      },
    }).serializedUnsignedTxHex();
    const serializedAuxiliaryData = RustModule.WasmScope(Module => {
      const transaction = Module.CML.Transaction.from_cbor_hex(serializedUnsignedTx);
      const auxiliaryData = transaction.auxiliary_data();
      const auxiliaryDataHash = transaction.body().auxiliary_data_hash();
      if (auxiliaryData == null || auxiliaryDataHash == null) throw new Error('Missing serialized connector auxiliary data');
      return {
        bytes: auxiliaryData.to_cbor_bytes(),
        hash: auxiliaryDataHash.to_hex(),
        nativeScriptCount: transaction.witness_set().native_scripts()?.len() ?? 0,
      };
    });
    expect(serializedAuxiliaryData.bytes).toEqual(response.auxiliaryData);
    expect(serializedAuxiliaryData.hash).toEqual(expectedAuxiliaryDataHash);
    expect(serializedAuxiliaryData.nativeScriptCount).toBe(1);
  });

  it('selects wallet UTxOs for minted targets and keeps the policy script in the sign request', async () => {
    const utxo = genAddressedUtxos()[3];
    const change = genSampleAdaAddresses()[3];
    if (utxo == null || change == null) throw new Error('Missing connector output fixtures');
    const policyScript = RustModule.WasmScope(Module =>
      Module.CML.NativeScript.new_script_pubkey(Module.CML.Ed25519KeyHash.from_hex('33'.repeat(28))).to_cbor_hex()
    );
    const policyId = RustModule.WasmScope(Module => Module.CML.NativeScript.from_cbor_hex(policyScript).hash().to_hex());
    const response = await newAdaUnsignedTxForConnector(
      [makeOutput(change.address, '2000000', '1', `${policyId}.74657374`)],
      [{ policyScript, assetName: '74657374', amount: '1' }],
      { metadata: {}, nativeScripts: [] },
      change,
      [],
      [utxo],
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
    expect(response.senderUtxos).toHaveLength(1);

    const request = new HaskellShelleyTxSignRequest({
      senderUtxos: response.senderUtxos,
      unsignedTx: response.txBuilder,
      witnessSet: response.witnessSet,
      changeAddr: response.changeAddr,
      metadata: response.auxiliaryData,
      networkSettingSnapshot: {
        NetworkId: network.NetworkId,
        ChainNetworkId: 1,
        PoolDeposit: new BigNumber('500000000'),
        KeyDeposit: new BigNumber('2000000'),
      },
    });
    const summary = RustModule.WasmScope(Module => {
      const transaction = Module.CML.Transaction.from_cbor_hex(request.serializedUnsignedTxHex());
      const mint = transaction.body().mint();
      const quantity = mint?.get(Module.CML.ScriptHash.from_hex(policyId), Module.CML.AssetName.from_hex('74657374'));
      const nativeScripts = transaction.witness_set().native_scripts();
      return {
        quantity: quantity?.toString(),
        nativeScriptCount: nativeScripts?.len() ?? 0,
        nativeScriptHash: nativeScripts?.get(0)?.hash().to_hex(),
      };
    });
    expect(summary).toEqual({ quantity: '1', nativeScriptCount: 1, nativeScriptHash: policyId });
  });

  it('keeps the fee above the serialized minimum for two Byron/bootstrap inputs', async () => {
    const [first, second] = [genAddressedUtxos()[0], genAddressedUtxos()[2]];
    const change = genSampleAdaAddresses()[3];
    if (change == null) throw new Error('Missing change address fixture');
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
      [
        [first, undefined],
        [second, undefined],
      ],
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
        if (byron == null) throw new Error('Invalid Byron UTxO address');
        const publicKey = new Uint8Array(32);
        publicKey[0] = index + 1;
        const signature = new Uint8Array(64);
        signature[0] = index + 1;
        witnesses.add_bootstrap(
          cml.BootstrapWitness.new(
            cml.PublicKey.from_bytes(publicKey),
            cml.Ed25519Signature.from_raw_bytes(signature),
            new Uint8Array(32),
            byron.content().addr_attributes()
          )
        );
      });
      const tx = cml.Transaction.new(cml.TransactionBody.from_cbor_bytes(response.txBuilder), witnesses.build(), true);
      return {
        fee: tx.body().fee(),
        minimum: cml.min_fee(
          tx,
          cml.LinearFee.new(BigInt('44'), BigInt('155381'), BigInt('0')),
          cml.ExUnitPrices.new(
            cml.Rational.new(BigInt('577'), BigInt('10000')),
            cml.Rational.new(BigInt('721'), BigInt('10000000'))
          ),
          BigInt('0')
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
        BigInt('0'),
        datum,
        cml.ExUnits.new(BigInt('14000000'), BigInt('10000000000'))
      );
      const address = cml.EnterpriseAddress.new(network.NetworkId, cml.Credential.new_script(script.hash())).to_address();
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
        cml.LinearFee.new(BigInt('44'), BigInt('155381'), BigInt('0')),
        cml.ExUnitPrices.new(
          cml.Rational.new(BigInt('577'), BigInt('10000')),
          cml.Rational.new(BigInt('721'), BigInt('10000000'))
        ),
        BigInt('0')
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
          cml.LegacyRedeemer.new(
            cml.RedeemerTag.Spend,
            BigInt('0'),
            datum,
            cml.ExUnits.new(BigInt('14000000'), BigInt('10000000000'))
          ).to_cbor_hex(),
          cml.LegacyRedeemer.new(
            cml.RedeemerTag.Spend,
            BigInt('1'),
            datum,
            cml.ExUnits.new(BigInt('28000000'), BigInt('20000000000'))
          ).to_cbor_hex(),
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
      inputs.map((input, index) => [
        input,
        {
          plutusScript: fixture.script,
          datum: fixture.datum,
          redeemer: fixture.redeemers[index],
        },
      ]),
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
          cml.LinearFee.new(BigInt('44'), BigInt('155381'), BigInt('0')),
          cml.ExUnitPrices.new(
            cml.Rational.new(BigInt('577'), BigInt('10000')),
            cml.Rational.new(BigInt('721'), BigInt('10000000'))
          ),
          BigInt('0')
        ),
      };
    });
    expect(minimumFee.inputCount).toBe(2);
    expect(minimumFee.fee).toBeGreaterThanOrEqual(minimumFee.minimum);
    expect(minimumFee.fee).toBeLessThanOrEqual(minimumFee.minimum + BigInt('10000'));
  });

  it('covers serialized fees for a mixed native-script and Plutus spend', async () => {
    const change = genSampleAdaAddresses()[3];
    const fixtures = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const nativeScript = cml.NativeScript.new_script_pubkey(cml.Ed25519KeyHash.from_hex('33'.repeat(28)));
      const plutusScript = cml.PlutusV1Script.from_hex('4e4d01000033222220051200120011');
      const plutus = cml.PlutusScript.from_v1(plutusScript);
      const datum = cml.PlutusData.from_cbor_hex('01');
      const redeemer = cml.LegacyRedeemer.new(
        cml.RedeemerTag.Spend,
        BigInt('0'),
        datum,
        cml.ExUnits.new(BigInt('14000000'), BigInt('10000000000'))
      );
      return {
        nativeScript: nativeScript.to_cbor_hex(),
        plutusScript: plutusScript.to_cbor_hex(),
        datum: datum.to_cbor_hex(),
        redeemer: redeemer.to_cbor_hex(),
        plutusAddress: cml.EnterpriseAddress.new(network.NetworkId, cml.Credential.new_script(plutus.hash()))
          .to_address()
          .to_hex(),
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
          cml.LinearFee.new(BigInt('44'), BigInt('155381'), BigInt('0')),
          cml.ExUnitPrices.new(
            cml.Rational.new(BigInt('577'), BigInt('10000')),
            cml.Rational.new(BigInt('721'), BigInt('10000000'))
          ),
          BigInt('0')
        ),
      };
    });
    expect(feeCheck.inputCount).toBe(2);
    expect(feeCheck.fee).toBeGreaterThanOrEqual(feeCheck.minimum);
    expect(feeCheck.fee).toBeLessThanOrEqual(feeCheck.minimum + BigInt('10000'));
  });

  it('preserves the insufficient-funds error for a connector input that cannot cover outputs', async () => {
    const change = genSampleAdaAddresses()[3];
    await expect(
      newAdaUnsignedTxForConnector(
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
      )
    ).rejects.toThrow(NotEnoughMoneyToSendError);
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
      const mint = body.mint();
      if (mint == null) throw new Error('Missing mint field');
      const amount = mint.get(Module.CML.ScriptHash.from_hex(script.policy), Module.CML.AssetName.from_hex(assetName));
      if (amount == null) throw new Error('Missing minted asset');
      return amount.toString();
    });
    expect(burnedAmount).toEqual('-1');
  });
});

describe('CML maximum send amount', () => {
  it('matches frozen fixed-input fee and change for an ADA-only transaction', async () => {
    const utxo = genSampleUtxos()[3];
    const receiverAddress = genSampleAdaAddresses()[0];
    if (utxo == null || receiverAddress == null) throw new Error('Missing maximum-send fixture');
    const receiver = receiverAddress.address;
    const queriedUtxo: QueriedUtxo = {
      address: utxo.receiver,
      addressing: { path: [0, 0], startLevel: 0 },
      output: {
        tokens: [
          {
            Token: ({ Identifier: defaultIdentifier }: any),
            TokenList: { Amount: utxo.amount },
          },
        ],
        Transaction: { Hash: utxo.tx_hash },
        UtxoTransactionOutput: {
          OutputIndex: utxo.tx_index,
          ErgoBoxId: null,
          ErgoCreationHeight: null,
          ErgoRegisters: null,
          ErgoTree: null,
        },
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

    // Golden result from the former fixed-input builder using production mainnet params.
    const legacyMaxAmount = new BigNumber('29834983');
    const legacyFee = new BigNumber('165017');
    expect(maxAmount.toString()).toBe(legacyMaxAmount.toString());
    expect(new BigNumber(utxo.amount).minus(maxAmount).toString()).toBe(legacyFee.toString());
  });
});
