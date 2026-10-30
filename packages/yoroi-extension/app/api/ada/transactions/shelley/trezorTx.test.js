// @flow

import '../../lib/test-config.forTests';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { toTrezorSignRequest, toTrezorAddressParameters, buildConnectorSignedTransaction } from './trezorTx';
import { networks } from '../../lib/storage/database/prepackaged/networks';
import { normalizeToAddress } from '../../lib/storage/bridge/utils';
import { CardanoCertificateType, CardanoAddressType, CardanoTxWitnessType, CardanoDRepType } from 'trezor-connect-flow';
import { ChainDerivations } from '../../../../config/numbersConfig';
import { hexToBytes } from '../../../../coreUtils';
import { createMetadata } from '../../lib/storage/bridge/metadataUtils';

beforeAll(async () => {
  await RustModule.load();
});

const network = networks.CardanoMainnet;

test('Generate address parameters', async () => {
  const path = [2147483692, 2147485463, 2147483648, 1, 1];

  // byron
  {
    const addr = 'Ae2tdPwUPEZLmqiKtMQ4kKL38emRfkyPqBsHqL64pf8uRz6uzsQCd7GAu9R';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(toTrezorAddressParameters(wasmAddr, path)).toEqual({
      addressType: CardanoAddressType.BYRON,
      path: "m/44'/1815'/0'/1/1",
    });
  }

  // base
  {
    const addr = 'addr1q8v42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqsx9990';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(toTrezorAddressParameters(wasmAddr, path)).toEqual({
      addressType: CardanoAddressType.BASE,
      path: "m/44'/1815'/0'/1/1",
      stakingKeyHash: '63073aa639558af724c96fbd1d01f35d087823e1e14b7d4e0fdb2132',
    });
  }

  // enterprise
  {
    const addr = 'addr1vxq0nckg3ekgzuqg7w5p9mvgnd9ym28qh5grlph8xd2z92su77c6m';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(toTrezorAddressParameters(wasmAddr, path)).toEqual({
      addressType: CardanoAddressType.ENTERPRISE,
      path: "m/44'/1815'/0'/1/1",
    });
  }

  // pointer
  {
    const addr = 'addr1gxq0nckg3ekgzuqg7w5p9mvgnd9ym28qh5grlph8xd2z92spqgpsl97q83';
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(toTrezorAddressParameters(wasmAddr, path)).toEqual({
      addressType: CardanoAddressType.POINTER,
      path: "m/44'/1815'/0'/1/1",
      certificatePointer: {
        blockIndex: 1,
        certificateIndex: 3,
        txIndex: 2,
      },
    });
  }

  // reward
  {
    const addr = 'stake1u8pcjgmx7962w6hey5hhsd502araxp26kdtgagakhaqtq8squng76';
    const stakingKeyPath = [2147483692, 2147485463, 2147483648, 2, 0];
    const wasmAddr = normalizeToAddress(addr);
    if (wasmAddr == null) throw new Error(`Unknown address`);
    expect(toTrezorAddressParameters(wasmAddr, stakingKeyPath)).toEqual({
      addressType: CardanoAddressType.REWARD,
      path: "m/44'/1815'/0'/2/0",
    });
  }
});

test('address parameters preserve script stake credentials with CML', () => {
  const addressHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const payment = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const stake = cml.Credential.new_script(cml.ScriptHash.from_hex('22'.repeat(28)));
    return cml.BaseAddress.new(0, payment, stake).to_address().to_hex();
  });
  expect(toTrezorAddressParameters(addressHex, [1, 2])).toEqual({
    addressType: CardanoAddressType.BASE,
    path: 'm/1/2',
    stakingKeyHash: '22'.repeat(28),
  });
});

test('Assemble Trezor witnesses and metadata with CML', () => {
  const metadata = createMetadata([{ label: '0', data: { hardware: 'trezor' } }]);
  const incomingPublicKeyHex = '02'.repeat(32);
  const existingSignatureHex = '03'.repeat(64);
  const incomingSignatureHex = '04'.repeat(64);
  const rawTxHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const inputs = cml.TransactionInputList.new();
    inputs.add(cml.TransactionInput.new(cml.TransactionHash.from_hex('11'.repeat(32)), BigInt('0')));
    const outputs = cml.TransactionOutputList.new();
    const address = cml.Address.from_bech32(
      'addr1q8v42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqsx9990'
    );
    outputs.add(cml.TransactionOutput.new(address, cml.Value.new(BigInt('5000000'), cml.MultiAsset.new())));
    const body = cml.TransactionBody.new(inputs, outputs, BigInt('170000'));
    const witnessSet = cml.TransactionWitnessSet.new();
    const existingVkeys = cml.VkeywitnessList.new();
    existingVkeys.add(
      cml.Vkeywitness.new(
        cml.PublicKey.from_bytes(new Uint8Array(32).fill(1)),
        cml.Ed25519Signature.from_raw_bytes(new Uint8Array(64).fill(3))
      )
    );
    witnessSet.set_vkeywitnesses(existingVkeys);
    return cml.Transaction.new(body, witnessSet, true).to_cbor_hex();
  });

  const signed = buildConnectorSignedTransaction(
    rawTxHex,
    [
      {
        type: CardanoTxWitnessType.SHELLEY_WITNESS,
        pubKey: incomingPublicKeyHex,
        signature: incomingSignatureHex,
      },
    ],
    metadata
  );
  const summary = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const transaction = cml.Transaction.from_cbor_hex(signed.txHex);
    const body = transaction.body();
    const vkeys = transaction.witness_set().vkeywitnesses();
    const auxiliaryData = transaction.auxiliary_data();
    const auxiliaryDataHash = body.auxiliary_data_hash();
    if (vkeys == null || auxiliaryData == null || auxiliaryDataHash == null)
      throw new Error('Missing signed transaction witnesses or metadata');
    return {
      txId: cml.hash_transaction(body).to_hex(),
      keyHashes: Array.from({ length: vkeys.len() }, (_, index) => vkeys.get(index).vkey().hash().to_hex()),
      signatures: Array.from({ length: vkeys.len() }, (_, index) => vkeys.get(index).ed25519_signature().to_hex()),
      metadataHex: auxiliaryData.to_cbor_hex(),
      metadataHash: auxiliaryDataHash.to_hex(),
      expectedMetadataHex: cml.AuxiliaryData.from_cbor_bytes(metadata).to_cbor_hex(),
      expectedMetadataHash: cml.hash_auxiliary_data(cml.AuxiliaryData.from_cbor_bytes(metadata)).to_hex(),
    };
  });

  expect(signed.txId).toEqual(summary.txId);
  expect(summary.keyHashes).toHaveLength(2);
  expect(summary.keyHashes[0]).toEqual(
    RustModule.WasmScope(Module => Module.CML.PublicKey.from_bytes(new Uint8Array(32).fill(1)).hash().to_hex())
  );
  expect(summary.keyHashes[1]).toEqual(
    RustModule.WasmScope(Module => Module.CML.PublicKey.from_bytes(new Uint8Array(32).fill(2)).hash().to_hex())
  );
  expect(summary.signatures).toEqual([existingSignatureHex, incomingSignatureHex]);
  expect(summary.metadataHex).toEqual(summary.expectedMetadataHex);
  expect(summary.metadataHash).toEqual(summary.expectedMetadataHash);
});

test('Create Trezor transaction', async () => {
  const senderUtxos = [
    {
      amount: '1494128',
      receiver: 'Ae2tdPwUPEZLmqiKtMQ4kKL38emRfkyPqBsHqL64pf8uRz6uzsQCd7GAu9R',
      tx_hash: '058405892f66075d83abd1b7fe341d2d5bfd2f6122b2f874700039e5078e0dd5',
      tx_index: 1,
      utxo_id: '058405892f66075d83abd1b7fe341d2d5bfd2f6122b2f874700039e5078e0dd51',
      addressing: {
        path: [2147483692, 2147485463, 2147483648, 1, 1],
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
        path: [2147483692, 2147485463, 2147483648, 0, 7],
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
        path: [2147483692, 2147485463, 2147483648, 0, 7],
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
        path: [2147483692, 2147485463, 2147483648, 1, 2],
        startLevel: 1,
      },
      assets: [],
    },
  ];
  const bodyHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const inputs = cml.TransactionInputList.new();
    // Transaction inputs are serialized as a ledger set; use canonical hash order as the old builder did.
    for (const utxo of [...senderUtxos].sort((left, right) => left.tx_hash.localeCompare(right.tx_hash))) {
      // eslint-disable-next-line no-undef
      inputs.add(cml.TransactionInput.new(cml.TransactionHash.from_hex(utxo.tx_hash), BigInt(utxo.tx_index)));
    }
    const multiAsset = cml.MultiAsset.new();
    multiAsset.set(cml.ScriptHash.from_hex('11'.repeat(28)), cml.AssetName.from_raw_bytes(hexToBytes('aabb')), BigInt('4'));
    const mintAssets = cml.MapAssetNameToNonZeroInt64.new();
    mintAssets.insert(cml.AssetName.from_raw_bytes(hexToBytes('cafe')), BigInt('-7'));
    const mint = cml.Mint.new();
    mint.insert_assets(cml.ScriptHash.from_hex('22'.repeat(28)), mintAssets);
    const outputs = cml.TransactionOutputList.new();
    outputs.add(
      cml.TransactionOutput.new(
        cml.Address.from_bech32('addr1stvpskppsdvpezg6ex464jvekztus84rcpzskramdy7sh53jh67q7j3er7sqqxhjlalzzsk0pgc'),
        cml.Value.new(BigInt('6323634'), multiAsset)
      )
    );

    // note: key doesn't belong to the account signing. Just used to test certificate parsing.
    const accountKey = cml.Bip32PrivateKey.from_raw_bytes(
      hexToBytes(
        '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247'
      )
    );
    const stakingKey = accountKey.derive(ChainDerivations.CHIMERIC_ACCOUNT).derive(0);
    const stakeCredential = cml.Credential.new_pub_key(stakingKey.to_raw_key().to_public().hash());
    const certificates = cml.CertificateList.new();
    certificates.add(cml.Certificate.new_stake_registration(stakeCredential));
    certificates.add(
      cml.Certificate.new_vote_deleg_cert(stakeCredential, cml.DRep.new_key(cml.Ed25519KeyHash.from_hex('33'.repeat(28))))
    );
    const body = cml.TransactionBody.new(inputs, outputs, BigInt('2000'));
    body.set_certs(certificates);
    body.set_ttl(BigInt('500'));
    body.set_mint(mint);
    return body.to_cbor_hex();
  });

  const baseConfig = network.BaseConfig.reduce((acc, next) => Object.assign(acc, next), {});
  const { ByronNetworkId, ChainNetworkId } = baseConfig;

  const response = toTrezorSignRequest(
    bodyHex,
    Number.parseInt(ChainNetworkId, 10),
    ByronNetworkId,
    _address => [2147483692, 2147485463, 2147483648, 2, 0],
    [],
    senderUtxos
  );
  expect(response).toStrictEqual({
    fee: '2000',
    ttl: '500',
    networkId: 1,
    protocolMagic: 764824073,
    includeNetworkId: false,
    inputs: [
      {
        path: [2147483692, 2147485463, 2147483648, 1, 1],
        prev_hash: '058405892f66075d83abd1b7fe341d2d5bfd2f6122b2f874700039e5078e0dd5',
        prev_index: 1,
      },
      {
        path: [2147483692, 2147485463, 2147483648, 0, 7],
        prev_hash: '1029eef5bb0f06979ab0b9530a62bac11e180797d08cab980fe39389d42b3657',
        prev_index: 0,
      },
      {
        path: [2147483692, 2147485463, 2147483648, 0, 7],
        prev_hash: '2029eef5bb0f06979ab0b9530a62bac11e180797d08cab980fe39389d42b3658',
        prev_index: 0,
      },
      {
        path: [2147483692, 2147485463, 2147483648, 1, 2],
        prev_hash: '3677e75c7ba699bfdc6cd57d42f246f86f69aefd76025006ac78313fad2bba20',
        prev_index: 1,
      },
    ],
    outputs: [
      {
        address: 'addr1stvpskppsdvpezg6ex464jvekztus84rcpzskramdy7sh53jh67q7j3er7sqqxhjlalzzsk0pgc',
        amount: `6323634`,
        tokenBundle: [
          {
            policyId: '11'.repeat(28),
            tokenAmounts: [{ assetNameBytes: 'aabb', amount: '4' }],
          },
        ],
      },
    ],
    certificates: [
      {
        path: [2147483692, 2147485463, 2147483648, 2, 0],
        type: CardanoCertificateType.STAKE_REGISTRATION,
      },
      {
        dRep: { type: CardanoDRepType.KEY_HASH, keyHash: '33'.repeat(28) },
        path: [2147483692, 2147485463, 2147483648, 2, 0],
        type: CardanoCertificateType.VOTE_DELEGATION,
      },
    ],
    signingMode: 0,
    tagCborSets: true,
    mint: [{ policyId: '22'.repeat(28), tokenAmounts: [{ assetNameBytes: 'cafe', mintAmount: '-7' }] }],
  });
});
