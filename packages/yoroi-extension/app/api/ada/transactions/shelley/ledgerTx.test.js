// @flow

import '../../lib/test-config.forTests';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { toLedgerSignRequest, buildConnectorSignedTransaction, toLedgerAddressParameters } from './ledgerTx';
import { byronAddrToHex, getCardanoSpendingKeyHash, normalizeToAddress } from '../../lib/storage/bridge/utils';
import {
  AddressType,
  CertificateType,
  TransactionSigningMode,
  TxOutputDestinationType,
  CredentialParamsType,
  TxOutputFormat,
} from '@cardano-foundation/ledgerjs-hw-app-cardano';
import type { DeviceOwnedAddress, SignTransactionRequest } from '@cardano-foundation/ledgerjs-hw-app-cardano';
import { networks } from '../../lib/storage/database/prepackaged/networks';
import { HARD_DERIVATION_START, WalletTypePurpose, CoinTypes, ChainDerivations } from '../../../../config/numbersConfig';
import { hexToBytes } from '../../../../coreUtils';
import { createMetadata } from '../../lib/storage/bridge/metadataUtils';

beforeAll(async () => {
  await RustModule.load();
});

const network = networks.CardanoMainnet;

function getProtocolParams(): {|
  linearFee: RustModule.WalletV4.LinearFee,
  coinsPerUtxoByte: RustModule.WalletV4.BigNum,
  poolDeposit: RustModule.WalletV4.BigNum,
  keyDeposit: RustModule.WalletV4.BigNum,
  networkId: number,
|} {
  return {
    linearFee: RustModule.WalletV4.LinearFee.new(
      RustModule.WalletV4.BigNum.from_str('2'),
      RustModule.WalletV4.BigNum.from_str('500')
    ),
    coinsPerUtxoByte: RustModule.WalletV4.BigNum.from_str('1'),
    poolDeposit: RustModule.WalletV4.BigNum.from_str('500'),
    keyDeposit: RustModule.WalletV4.BigNum.from_str('500'),
    networkId: network.NetworkId,
  };
}

test('Generate address parameters', async () => {
  const baseConfig = network.BaseConfig.reduce((acc, next) => Object.assign(acc, next), {});
  const { ChainNetworkId } = baseConfig;

  const path = [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 1];

  // byron
  {
    const addr = 'Ae2tdPwUPEZLmqiKtMQ4kKL38emRfkyPqBsHqL64pf8uRz6uzsQCd7GAu9R';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(
      toLedgerAddressParameters({
        addressHex: wasmAddr,
        networkId: Number.parseInt(ChainNetworkId, 10),
        path,
        addressingMap: () => undefined,
      })
    ).toEqual(
      ({
        type: AddressType.BYRON,
        params: {
          spendingPath: path,
        },
      }: DeviceOwnedAddress)
    );
  }

  // base (staking key)
  {
    const addr = 'addr1q8v42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqsx9990';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(
      toLedgerAddressParameters({
        addressHex: wasmAddr,
        networkId: Number.parseInt(ChainNetworkId, 10),
        path,
        addressingMap: () => undefined,
      })
    ).toEqual(
      ({
        type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
        params: {
          spendingPath: path,
          stakingKeyHashHex: '63073aa639558af724c96fbd1d01f35d087823e1e14b7d4e0fdb2132',
        },
      }: DeviceOwnedAddress)
    );
  }

  // base (path)
  {
    const stakingKeyPath = [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, HARD_DERIVATION_START, 2, 0];
    const addr = 'addr1q8v42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqsx9990';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(
      toLedgerAddressParameters({
        addressHex: wasmAddr,
        path,
        networkId: Number.parseInt(ChainNetworkId, 10),
        addressingMap: address => {
          if (address === 'e163073aa639558af724c96fbd1d01f35d087823e1e14b7d4e0fdb2132') {
            return {
              startLevel: 1,
              path: stakingKeyPath,
            };
          }
          return undefined;
        },
      })
    ).toEqual(
      ({
        type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
        params: {
          spendingPath: path,
          stakingPath: stakingKeyPath,
        },
      }: DeviceOwnedAddress)
    );
  }

  // enterprise
  {
    const addr = 'addr1vxq0nckg3ekgzuqg7w5p9mvgnd9ym28qh5grlph8xd2z92su77c6m';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(
      toLedgerAddressParameters({
        addressHex: wasmAddr,
        networkId: Number.parseInt(ChainNetworkId, 10),
        path,
        addressingMap: () => undefined,
      })
    ).toEqual(
      ({
        type: AddressType.ENTERPRISE_KEY,
        params: {
          spendingPath: path,
        },
      }: DeviceOwnedAddress)
    );
  }

  // pointer
  {
    const addr = 'addr1gxq0nckg3ekgzuqg7w5p9mvgnd9ym28qh5grlph8xd2z92spqgpsl97q83';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(
      toLedgerAddressParameters({
        addressHex: wasmAddr,
        networkId: Number.parseInt(ChainNetworkId, 10),
        path,
        addressingMap: () => undefined,
      })
    ).toEqual(
      ({
        type: AddressType.POINTER_KEY,
        params: {
          spendingPath: path,
          stakingBlockchainPointer: {
            blockIndex: 1,
            certificateIndex: 3,
            txIndex: 2,
          },
        },
      }: DeviceOwnedAddress)
    );
  }

  // reward
  {
    const addr = 'stake1u8pcjgmx7962w6hey5hhsd502araxp26kdtgagakhaqtq8squng76';
    const stakingKeyPath = [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, HARD_DERIVATION_START, 2, 0];
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(
      toLedgerAddressParameters({
        addressHex: wasmAddr,
        networkId: Number.parseInt(ChainNetworkId, 10),
        path: stakingKeyPath,
        addressingMap: () => undefined,
      })
    ).toEqual(
      ({
        type: AddressType.REWARD_KEY,
        params: {
          stakingPath: stakingKeyPath,
        },
      }: DeviceOwnedAddress)
    );
  }
});

test('Ledger address parameters preserve script stake credentials with CML', () => {
  const addressHex = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const payment = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const stake = CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex('22'.repeat(28)));
    return CSL.BaseAddress.new(0, payment, stake).to_address().to_hex();
  });
  expect(
    toLedgerAddressParameters({
      addressHex,
      networkId: 0,
      path: [1, 2],
      addressingMap: () => undefined,
    })
  ).toEqual({
    type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
    params: { spendingPath: [1, 2], stakingKeyHashHex: '22'.repeat(28) },
  });
});

test('Create Ledger transaction', async () => {
  const senderUtxos = [
    {
      amount: '1494128',
      receiver: 'Ae2tdPwUPEZLmqiKtMQ4kKL38emRfkyPqBsHqL64pf8uRz6uzsQCd7GAu9R',
      tx_hash: '058405892f66075d83abd1b7fe341d2d5bfd2f6122b2f874700039e5078e0dd5',
      tx_index: 1,
      utxo_id: '058405892f66075d83abd1b7fe341d2d5bfd2f6122b2f874700039e5078e0dd51',
      addressing: {
        path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 1],
        startLevel: 1,
      },
      assets: [],
    },
    {
      amount: '2832006',
      // base
      receiver: 'addr1q8v42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqsx9990',
      tx_hash: '3677e75c7ba699bfdc6cd57d42f246f86f69aefd76025006ac78313fad2bba20',
      tx_index: 1,
      utxo_id: '3677e75c7ba699bfdc6cd57d42f246f86f69aefd76025006ac78313fad2bba201',
      addressing: {
        path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 2],
        startLevel: 1,
      },
      assets: [],
    },
    {
      amount: '1000000',
      // enterprise
      receiver: 'addr1vxq0nckg3ekgzuqg7w5p9mvgnd9ym28qh5grlph8xd2z92su77c6m',
      tx_hash: '1029eef5bb0f06979ab0b9530a62bac11e180797d08cab980fe39389d42b3657',
      tx_index: 0,
      utxo_id: '1029eef5bb0f06979ab0b9530a62bac11e180797d08cab980fe39389d42b36570',
      addressing: {
        path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 0, 7],
        startLevel: 1,
      },
      assets: [],
    },
    {
      amount: '1000000',
      // pointer
      receiver: 'addr1gxq0nckg3ekgzuqg7w5p9mvgnd9ym28qh5grlph8xd2z92spqgpsl97q83',
      tx_hash: '2029eef5bb0f06979ab0b9530a62bac11e180797d08cab980fe39389d42b3658',
      tx_index: 0,
      utxo_id: '2029eef5bb0f06979ab0b9530a62bac11e180797d08cab980fe39389d42b36571',
      addressing: {
        path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 0, 7],
        startLevel: 1,
      },
      assets: [],
    },
  ];
  const protocolParams = getProtocolParams();
  const txBuilder = RustModule.WalletV4TxBuilder(protocolParams);
  for (const utxo of senderUtxos) {
    const wasmAddr = normalizeToAddress(utxo.receiver);
    if (wasmAddr == null) throw new Error(`Unknown address ${utxo.receiver}`);
    const keyHash = getCardanoSpendingKeyHash(wasmAddr);
    if (keyHash === undefined) throw new Error(`Unexpected script address ${utxo.receiver}`);
    if (keyHash == null) {
      txBuilder.add_bootstrap_input(
        RustModule.WalletV4.ByronAddress.from_base58(utxo.receiver),
        RustModule.WalletV4.TransactionInput.new(RustModule.WalletV4.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index),
        RustModule.WalletV4.Value.new(RustModule.WalletV4.BigNum.from_str(utxo.amount))
      );
    } else {
      txBuilder.add_key_input(
        RustModule.WalletV4.Ed25519KeyHash.from_hex(keyHash),
        RustModule.WalletV4.TransactionInput.new(RustModule.WalletV4.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index),
        RustModule.WalletV4.Value.new(RustModule.WalletV4.BigNum.from_str(utxo.amount))
      );
    }
  }
  txBuilder.add_output(
    RustModule.WalletV4.TransactionOutput.new(
      RustModule.WalletV4.Address.from_hex(byronAddrToHex('Ae2tdPwUPEZAVDjkPPpwDhXMSAjH53CDmd2xMwuR9tZMAZWxLhFphrHKHXe')),
      RustModule.WalletV4.Value.new(RustModule.WalletV4.BigNum.from_str('6323634'))
    )
  );
  const certs = RustModule.WalletV4.Certificates.new();

  // note: key doesn't belong to the account signing. Just used to test witness generation
  const accountKey = RustModule.WalletV4.Bip32PrivateKey.from_bytes(
    hexToBytes(
      '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247'
    )
  );
  const stakingKey = accountKey.derive(ChainDerivations.CHIMERIC_ACCOUNT).derive(0);

  const stakeCredential = RustModule.WalletV4.Credential.from_keyhash(stakingKey.to_raw_key().to_public().hash());
  certs.add(RustModule.WalletV4.Certificate.new_stake_registration(RustModule.WalletV4.StakeRegistration.new(stakeCredential)));
  txBuilder.set_certs(certs);
  txBuilder.set_fee(RustModule.WalletV4.BigNum.from_str('2000'));
  txBuilder.set_ttl(500);

  const baseConfig = network.BaseConfig.reduce((acc, next) => Object.assign(acc, next), {});
  const { ByronNetworkId, ChainNetworkId } = baseConfig;

  const stakingKeyInfo = {
    keyHash: stakingKey.to_public().to_raw_key().hash(),
    addressing: {
      startLevel: 1,
      path: [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, HARD_DERIVATION_START, 2, 0],
    },
  };

  const rewardAddressString = RustModule.WalletV4.RewardAddress.new(
    Number.parseInt(baseConfig.ChainNetworkId, 10),
    stakeCredential
  )
    .to_address()
    .to_hex();
  const response = await toLedgerSignRequest(
    txBuilder.build().to_hex(),
    Number.parseInt(ChainNetworkId, 10),
    ByronNetworkId,
    address => {
      if (address === rewardAddressString) {
        return stakingKeyInfo.addressing.path;
      }
      return undefined;
    },
    [],
    senderUtxos
  );

  expect(response).toStrictEqual(
    ({
      options: {
        tagCborSets: true,
      },
      signingMode: TransactionSigningMode.ORDINARY_TRANSACTION,
      tx: {
        fee: '2000',
        ttl: '500',
        scriptDataHashHex: null,
        votingProcedures: null,
        network: {
          networkId: 1,
          protocolMagic: 764824073,
        },
        inputs: [
          {
            path: [44 + HARD_DERIVATION_START, 1815 + HARD_DERIVATION_START, 0 + HARD_DERIVATION_START, 1, 1],
            txHashHex: '058405892f66075d83abd1b7fe341d2d5bfd2f6122b2f874700039e5078e0dd5',
            outputIndex: 1,
          },
          {
            path: [44 + HARD_DERIVATION_START, 1815 + HARD_DERIVATION_START, 0 + HARD_DERIVATION_START, 0, 7],
            txHashHex: '1029eef5bb0f06979ab0b9530a62bac11e180797d08cab980fe39389d42b3657',
            outputIndex: 0,
          },
          {
            path: [44 + HARD_DERIVATION_START, 1815 + HARD_DERIVATION_START, 0 + HARD_DERIVATION_START, 0, 7],
            txHashHex: '2029eef5bb0f06979ab0b9530a62bac11e180797d08cab980fe39389d42b3658',
            outputIndex: 0,
          },
          {
            path: [44 + HARD_DERIVATION_START, 1815 + HARD_DERIVATION_START, 0 + HARD_DERIVATION_START, 1, 2],
            txHashHex: '3677e75c7ba699bfdc6cd57d42f246f86f69aefd76025006ac78313fad2bba20',
            outputIndex: 1,
          },
        ],
        outputs: [
          {
            format: TxOutputFormat.ARRAY_LEGACY,
            destination: {
              params: {
                addressHex: '82d818582183581c891ac9abaac999b097c81ea3c0450b0fbb693d0bd232bebc0f4a391fa0001af2ff7e21',
              },
              type: TxOutputDestinationType.THIRD_PARTY,
            },
            amount: `6323634`,
            datumHashHex: null,
            tokenBundle: null,
          },
        ],
        withdrawals: null,
        certificates: [
          {
            params: {
              stakeCredential: {
                type: CredentialParamsType.KEY_PATH,
                keyPath: [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, HARD_DERIVATION_START, 2, 0],
              },
            },
            type: CertificateType.STAKE_REGISTRATION,
          },
        ],
        auxiliaryData: null,
        validityIntervalStart: null,
        collateralInputs: null,
        collateralOutput: undefined,
        includeNetworkId: false,
        mint: null,
        referenceInputs: null,
        requiredSigners: null,
        totalCollateral: null,
      },
      additionalWitnessPaths: [],
    }: SignTransactionRequest)
  );

  const metadata = createMetadata([{ label: '0', data: { hardware: 'ledger' } }]);
  const originalBodyHex = txBuilder.build().to_hex();
  const signedResult = buildConnectorSignedTransaction(
    RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const original = cml.Transaction.from_cbor_hex(txBuilder.build_tx().to_hex());
      const existingWitnessBuilder = cml.TransactionWitnessSetBuilder.new();
      const existingKey = cml.PublicKey.from_bytes(new Uint8Array(32).fill(1));
      const existingSignature = cml.Ed25519Signature.from_raw_bytes(new Uint8Array(64).fill(2));
      existingWitnessBuilder.add_vkey(cml.Vkeywitness.new(existingKey, existingSignature));
      return cml.Transaction.new(original.body(), existingWitnessBuilder.build(), true).to_cbor_hex();
    }),
    [
      // this witnesses doesn't belong to the transaction / key. Just used to test wit generation
      {
        path: [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 1],
        witnessSignatureHex:
          'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207',
      },
      {
        path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 1],
        witnessSignatureHex:
          'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207',
      },
      {
        path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 2],
        witnessSignatureHex:
          'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207',
      },
      {
        path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 0, 7],
        witnessSignatureHex:
          'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207',
      },
      {
        path: [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 2, 0],
        witnessSignatureHex:
          'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207',
      },
    ],
    {
      addressing: {
        startLevel: 1,
        path: [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, HARD_DERIVATION_START],
      },
      key: accountKey.to_public(),
    },
    metadata,
    new Map([
      [
        [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 1].join('/'),
        senderUtxos[0].receiver,
      ],
    ])
  );
  const signedSummary = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const tx = cml.Transaction.from_cbor_hex(signedResult.txHex);
    const body = tx.body();
    const witnesses = tx.witness_set();
    const vkeys = witnesses.vkeywitnesses();
    const bootstraps = witnesses.bootstrap_witnesses();
    const auxiliaryData = tx.auxiliary_data();
    return {
      bodyHex: body.to_cbor_hex(),
      txId: cml.hash_transaction(body).to_hex(),
      vkeyHashes: Array.from({ length: vkeys.len() }, (_, index) => vkeys.get(index).vkey().hash().to_hex()),
      finalVkeySignatureHex: vkeys.get(vkeys.len() - 1).ed25519_signature().to_hex(),
      bootstrapCount: bootstraps.len(),
      bootstrapHex: bootstraps.get(0).to_cbor_hex(),
      auxiliaryDataHex: auxiliaryData.to_cbor_hex(),
      auxiliaryDataHash: body.auxiliary_data_hash().to_hex(),
      expectedAuxiliaryDataHash: cml.hash_auxiliary_data(cml.AuxiliaryData.from_cbor_bytes(metadata)).to_hex(),
    };
  });
  expect(signedSummary.bodyHex).not.toEqual(originalBodyHex);
  expect(signedResult.txId).toEqual(signedSummary.txId);
  expect(signedSummary.vkeyHashes).toHaveLength(2);
  expect(signedSummary.vkeyHashes[0]).toEqual(
    RustModule.WasmScope(Module => Module.CML.PublicKey.from_bytes(new Uint8Array(32).fill(1)).hash().to_hex())
  );
  expect(signedSummary.finalVkeySignatureHex).toEqual(
    'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207'
  );
  expect(signedSummary.bootstrapCount).toEqual(1);
  const byronPath = [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 1];
  let bootstrapKey = accountKey.to_public();
  for (const index of byronPath.slice(3)) bootstrapKey = bootstrapKey.derive(index);
  expect(signedSummary.bootstrapHex).toEqual(
    RustModule.WalletV4.BootstrapWitness.new(
      RustModule.WalletV4.Vkey.new(bootstrapKey.to_raw_key()),
      RustModule.WalletV4.Ed25519Signature.from_hex(
        'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207'
      ),
      bootstrapKey.chaincode(),
      RustModule.WalletV4.ByronAddress.from_base58(senderUtxos[0].receiver).attributes()
    ).to_hex()
  );
  expect(signedSummary.auxiliaryDataHex).toEqual(
    RustModule.WasmScope(Module => Module.CML.AuxiliaryData.from_cbor_bytes(metadata).to_cbor_hex())
  );
  expect(signedSummary.auxiliaryDataHash).toEqual(signedSummary.expectedAuxiliaryDataHash);
});
