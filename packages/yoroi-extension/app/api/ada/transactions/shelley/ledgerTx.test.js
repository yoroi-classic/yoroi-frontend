// @flow

import '../../lib/test-config.forTests';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { toLedgerSignRequest, buildConnectorSignedTransaction, toLedgerAddressParameters } from './ledgerTx';
import { byronAddrToHex, normalizeToAddress } from '../../lib/storage/bridge/utils';
import {
  AddressType,
  CertificateType,
  TransactionSigningMode,
  TxOutputDestinationType,
  VoteOption,
  VoterType,
  CredentialParamsType,
  DatumType,
  TxOutputFormat,
} from '@cardano-foundation/ledgerjs-hw-app-cardano';
import type { DeviceOwnedAddress, SignTransactionRequest } from '@cardano-foundation/ledgerjs-hw-app-cardano';
import { networks } from '../../lib/storage/database/prepackaged/networks';
import { HARD_DERIVATION_START, WalletTypePurpose, CoinTypes, ChainDerivations } from '../../../../config/numbersConfig';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';
import { createMetadata } from '../../lib/storage/bridge/metadataUtils';

beforeAll(async () => {
  await RustModule.load();
});

const network = networks.CardanoMainnet;

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

test('parses CML DRep voting procedures for Ledger signing', () => {
  const cml = RustModule.CML;
  const keyHash = cml.Ed25519KeyHash.from_hex('11'.repeat(28));
  const voter = cml.Voter.new_d_rep_key_hash(keyHash);
  // eslint-disable-next-line no-undef
  const govActionId = cml.GovActionId.new(cml.TransactionHash.from_hex('22'.repeat(32)), BigInt('0'));
  const anchor = cml.Anchor.from_cbor_hex(`827368747470733a2f2f6578616d706c652e636f6d5820${'33'.repeat(32)}`);
  const proceduresByAction = cml.MapGovActionIdToVotingProcedure.new();
  proceduresByAction.insert(govActionId, cml.VotingProcedure.new(cml.Vote.Yes, anchor));
  const votingProcedures = cml.VotingProcedures.new();
  votingProcedures.insert(voter, proceduresByAction);
  const outputs = cml.TransactionOutputList.new();
  outputs.add(
    cml.TransactionOutput.new(
      cml.Address.from_hex(byronAddrToHex('Ae2tdPwUPEZAVDjkPPpwDhXMSAjH53CDmd2xMwuR9tZMAZWxLhFphrHKHXe')),
      cml.Value.new(BigInt('1000000'), cml.MultiAsset.new())
    )
  );
  const body = cml.TransactionBody.new(cml.TransactionInputList.new(), outputs, BigInt('170000'));
  body.set_voting_procedures(votingProcedures);
  const certificate = cml.Certificate.new_reg_drep_cert(
    cml.Credential.new_pub_key(keyHash),
    // eslint-disable-next-line no-undef
    BigInt('500000000'),
    anchor
  );
  const certificates = cml.CertificateList.new();
  certificates.add(certificate);
  body.set_certs(certificates);

  const request = toLedgerSignRequest(
    body.to_cbor_hex(),
    1,
    764824073,
    () => [1852 + HARD_DERIVATION_START, 1815 + HARD_DERIVATION_START, HARD_DERIVATION_START, 3, 0],
    [],
    []
  );

  expect(request.tx.votingProcedures).toEqual([
    {
      voter: {
        type: VoterType.DREP_KEY_PATH,
        keyPath: [1852 + HARD_DERIVATION_START, 1815 + HARD_DERIVATION_START, HARD_DERIVATION_START, 3, 0],
      },
      votes: [
        {
          govActionId: { txHashHex: '22'.repeat(32), govActionIndex: 0 },
          votingProcedure: {
            vote: VoteOption.YES,
            anchor: { url: 'https://example.com', hashHex: '33'.repeat(32) },
          },
        },
      ],
    },
  ]);
  expect(request.tx.certificates[0].type).toBe(CertificateType.DREP_REGISTRATION);
});

test('Ledger address parameters preserve script stake credentials with CML', () => {
  const addressHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const payment = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const stake = cml.Credential.new_script(cml.ScriptHash.from_hex('22'.repeat(28)));
    return cml.BaseAddress.new(0, payment, stake)
      .to_address()
      .to_hex();
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

test('Ledger request preserves inline datum and reference script and deduplicates required signers', () => {
  const fixture = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const paymentHash = '31'.repeat(28);
    const address = cml.EnterpriseAddress.new(
      1,
      cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(paymentHash))
    ).to_address();
    const datum = cml.PlutusData.new_integer(cml.BigInteger.from_str('42'));
    const script = cml.Script.new_native(cml.NativeScript.new_script_pubkey(cml.Ed25519KeyHash.from_hex('32'.repeat(28))));
    const output = cml.TransactionOutputBuilder.new()
      .with_address(address)
      .with_data(cml.DatumOption.new_datum(datum))
      .with_reference_script(script)
      .next()
      .with_value(cml.Value.from_coin(BigInt('5000000')))
      .build()
      .output();
    const outputs = cml.TransactionOutputList.new();
    outputs.add(output);
    const signers = cml.Ed25519KeyHashList.new();
    signers.add(cml.Ed25519KeyHash.from_hex(paymentHash));
    signers.add(cml.Ed25519KeyHash.from_hex(paymentHash));
    const body = cml.TransactionBody.new(cml.TransactionInputList.new(), outputs, BigInt('170000'));
    body.set_required_signers(signers);
    return {
      addressHex: address.to_hex(),
      bodyHex: body.to_cbor_hex(),
      datumHex: datum.to_cbor_hex(),
      scriptHex: script.to_cbor_hex(),
      paymentHash,
    };
  });

  const request = toLedgerSignRequest(
    fixture.bodyHex,
    1,
    764824073,
    address => (address === fixture.addressHex ? [1, 2, 3] : undefined),
    [],
    []
  );

  expect(request.tx.outputs[0].datum).toEqual({ type: DatumType.INLINE, datumHex: fixture.datumHex });
  expect(request.tx.outputs[0].referenceScriptHex).toBe(fixture.scriptHex);
  expect(request.tx.requiredSigners).toHaveLength(1);
  expect(request.additionalWitnessPaths).toEqual([[1, 2, 3]]);
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
  const txData = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const inputs = cml.TransactionInputList.new();
    // Transaction inputs are serialized as a ledger set; use canonical hash order as the old builder did.
    for (const utxo of [...senderUtxos].sort((left, right) => left.tx_hash.localeCompare(right.tx_hash))) {
      // eslint-disable-next-line no-undef
      const input = cml.TransactionInput.new(cml.TransactionHash.from_hex(utxo.tx_hash), BigInt(utxo.tx_index));
      inputs.add(input);
    }
    const outputs = cml.TransactionOutputList.new();
    outputs.add(
      cml.TransactionOutput.new(
        cml.Address.from_hex(byronAddrToHex('Ae2tdPwUPEZAVDjkPPpwDhXMSAjH53CDmd2xMwuR9tZMAZWxLhFphrHKHXe')),
        cml.Value.new(BigInt('6323634'), cml.MultiAsset.new())
      )
    );

    // This key is only used to construct a deterministic registration certificate fixture.
    const accountKey = cml.Bip32PrivateKey.from_raw_bytes(
      hexToBytes(
        '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247'
      )
    );
    const stakingKey = accountKey.derive(ChainDerivations.CHIMERIC_ACCOUNT).derive(0);
    const stakeCredential = cml.Credential.new_pub_key(
      stakingKey
        .to_raw_key()
        .to_public()
        .hash()
    );
    const certificates = cml.CertificateList.new();
    certificates.add(cml.Certificate.new_stake_registration(stakeCredential));
    const body = cml.TransactionBody.new(inputs, outputs, BigInt('2000'));
    body.set_certs(certificates);
    body.set_ttl(BigInt('500'));
    const rewardAddressString = cml.RewardAddress.new(Number.parseInt(network.BaseConfig[0].ChainNetworkId, 10), stakeCredential)
      .to_address()
      .to_hex();
    return {
      bodyHex: body.to_cbor_hex(),
      txHex: cml.Transaction.new(body, cml.TransactionWitnessSet.new(), true).to_cbor_hex(),
      accountPublicKeyBytes: accountKey.to_public().to_raw_bytes(),
      rewardAddressString,
    };
  });

  const baseConfig = network.BaseConfig.reduce((acc, next) => Object.assign(acc, next), {});
  const { ByronNetworkId, ChainNetworkId } = baseConfig;

  const stakingKeyInfo = {
    addressing: {
      startLevel: 1,
      path: [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, HARD_DERIVATION_START, 2, 0],
    },
  };

  const response = await toLedgerSignRequest(
    txData.bodyHex,
    Number.parseInt(ChainNetworkId, 10),
    ByronNetworkId,
    address => {
      if (address === txData.rewardAddressString) {
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
  const originalBodyHex = txData.bodyHex;
  const signedResult = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    return buildConnectorSignedTransaction(
      RustModule.WasmScope(InnerModule => {
        const innerCml = InnerModule.CML;
        const original = innerCml.Transaction.from_cbor_hex(txData.txHex);
        const existingWitnessBuilder = innerCml.TransactionWitnessSetBuilder.new();
        const existingKey = innerCml.PublicKey.from_bytes(new Uint8Array(32).fill(1));
        const existingSignature = innerCml.Ed25519Signature.from_raw_bytes(new Uint8Array(64).fill(2));
        existingWitnessBuilder.add_vkey(innerCml.Vkeywitness.new(existingKey, existingSignature));
        return innerCml.Transaction.new(original.body(), existingWitnessBuilder.build(), true).to_cbor_hex();
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
        key: cml.Bip32PublicKey.from_raw_bytes(txData.accountPublicKeyBytes),
      },
      metadata,
      new Map([[[WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 1].join('/'), senderUtxos[0].receiver]])
    );
  });
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
      vkeyHashes: Array.from({ length: vkeys.len() }, (_, index) =>
        vkeys
          .get(index)
          .vkey()
          .hash()
          .to_hex()
      ),
      finalVkeySignatureHex: vkeys
        .get(vkeys.len() - 1)
        .ed25519_signature()
        .to_hex(),
      bootstrapCount: bootstraps.len(),
      bootstrapPublicKeyHex: bytesToHex(
        bootstraps
          .get(0)
          .public_key()
          .to_raw_bytes()
      ),
      bootstrapSignatureHex: bootstraps
        .get(0)
        .signature()
        .to_hex(),
      bootstrapChainCodeHex: bytesToHex(bootstraps.get(0).chain_code()),
      bootstrapAttributesHex: bootstraps
        .get(0)
        .attributes()
        .to_cbor_hex(),
      auxiliaryDataHex: auxiliaryData.to_cbor_hex(),
      auxiliaryDataHash: body.auxiliary_data_hash().to_hex(),
      expectedAuxiliaryDataHash: cml.hash_auxiliary_data(cml.AuxiliaryData.from_cbor_bytes(metadata)).to_hex(),
    };
  });
  expect(signedSummary.bodyHex).not.toEqual(originalBodyHex);
  expect(signedResult.txId).toEqual(signedSummary.txId);
  expect(signedSummary.vkeyHashes).toHaveLength(2);
  expect(signedSummary.vkeyHashes[0]).toEqual(
    RustModule.WasmScope(Module =>
      Module.CML.PublicKey.from_bytes(new Uint8Array(32).fill(1))
        .hash()
        .to_hex()
    )
  );
  expect(signedSummary.finalVkeySignatureHex).toEqual(
    'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207'
  );
  expect(signedSummary.bootstrapCount).toEqual(1);
  const byronPath = [WalletTypePurpose.BIP44, CoinTypes.CARDANO, HARD_DERIVATION_START, 1, 1];
  expect(signedSummary.bootstrapSignatureHex).toEqual(
    'dc273ee8929c240f95b27b29b53043eb31dc1a5d8c1ba4a44b678bc97bb84db34c05144b50df954e1ac73dec1d33df06e4d95c3c7874458e7fea873c90614207'
  );
  const expectedBootstrap = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const privateKey = cml.Bip32PrivateKey.from_raw_bytes(
      hexToBytes(
        '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247'
      )
    );
    let bootstrapKey = privateKey.to_public();
    for (const index of byronPath.slice(3)) bootstrapKey = bootstrapKey.derive(index);
    return {
      publicKeyHex: bytesToHex(bootstrapKey.to_raw_key().to_raw_bytes()),
      chainCodeHex: bytesToHex(bootstrapKey.chaincode()),
      attributesHex: cml.ByronAddress.from_base58(senderUtxos[0].receiver)
        .content()
        .addr_attributes()
        .to_cbor_hex(),
    };
  });
  expect(signedSummary.bootstrapPublicKeyHex).toEqual(expectedBootstrap.publicKeyHex);
  expect(signedSummary.bootstrapChainCodeHex).toEqual(expectedBootstrap.chainCodeHex);
  expect(signedSummary.bootstrapAttributesHex).toEqual(expectedBootstrap.attributesHex);
  expect(signedSummary.auxiliaryDataHex).toEqual(
    RustModule.WasmScope(Module => Module.CML.AuxiliaryData.from_cbor_bytes(metadata).to_cbor_hex())
  );
  expect(signedSummary.auxiliaryDataHash).toEqual(signedSummary.expectedAuxiliaryDataHash);
});
