// @flow

import '../../../app/api/ada/lib/test-config.forTests';
import { RustModule } from '../../../app/api/ada/lib/cardanoCrypto/rustLoader';

describe('connectorGetUtxosCardano CML selection', () => {
  test('returns token-bearing UTxOs for a serialized multiasset value', async () => {
    await RustModule.load();
    const fixture = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const policyId = cml.NativeScript.new_script_pubkey(cml.Ed25519KeyHash.from_hex('44'.repeat(28)))
        .hash()
        .to_hex();
      const assetName = '74657374';
      const multiAsset = cml.MultiAsset.new();
      const assets = cml.MapAssetNameToCoin.new();
      assets.insert(cml.AssetName.from_hex(assetName), BigInt('2'));
      multiAsset.insert_assets(cml.ScriptHash.from_hex(policyId), assets);
      return {
        address: cml.EnterpriseAddress.new(1, cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28))))
          .to_address()
          .to_hex(),
        policyId,
        assetName,
        valueHex: cml.Value.new(BigInt('1000000'), multiAsset).to_cbor_hex(),
      };
    });
    const tokenId = `${fixture.policyId}.${fixture.assetName}`;
    const dbUtxos = ['1', '2'].map((hash, index) => ({
      address: fixture.address,
      addressing: { path: [0, index], startLevel: 3 },
      output: {
        tokens: [
          { Token: { Identifier: '' }, TokenList: { Amount: '5000000' } },
          { Token: { Identifier: tokenId }, TokenList: { Amount: '1' } },
        ],
        Transaction: { Hash: hash.repeat(64) },
        UtxoTransactionOutput: { OutputIndex: 0 },
      },
    }));
    jest.doMock('../../../app/api/ada/lib/storage/models/PublicDeriver/traits', () => {
      const actual = jest.requireActual('../../../app/api/ada/lib/storage/models/PublicDeriver/traits');
      return {
        ...actual,
        asGetAllUtxos: wallet => ({ getAllUtxos: async () => wallet.testUtxos }),
      };
    });
    jest.doMock('../../../app/api/localStorage', () => {
      const actual = jest.requireActual('../../../app/api/localStorage');
      return { ...actual, loadSubmittedTransactions: async () => [] };
    });
    jest.doMock('../../../app/api/ada', () => {
      const actual = jest.requireActual('../../../app/api/ada');
      return {
        __esModule: true,
        ...actual,
        default: class {
          utxosWithSubmittedTxs(utxos) {
            return utxos;
          }
        },
      };
    });
    const { connectorGetUtxosCardano } = require('./api');
    const result = await connectorGetUtxosCardano({ publicDeriverId: 1, testUtxos: dbUtxos }, fixture.valueHex, null, '4310');

    expect(result).toHaveLength(2);
    expect(result.every(utxo => utxo.assets.some(asset => asset.assetId === tokenId))).toBe(true);
  });

  test('serializes connector UTxOs through the CML bridge with legacy-compatible CBOR', async () => {
    await RustModule.load();
    const cml = RustModule.CML;
    const address = cml.EnterpriseAddress.new(
      1,
      cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)))
    ).to_address();
    const utxo = {
      utxo_id: `${'22'.repeat(32)}1`,
      tx_hash: '22'.repeat(32),
      tx_index: 1,
      receiver: address.to_hex(),
      amount: '5000000',
      assets: [{ assetId: `${'44'.repeat(28)}.74657374`, policyId: '44'.repeat(28), name: '74657374', amount: '7' }],
    };
    const { transformCardanoUtxos } = require('./api');
    const [actual] = await transformCardanoUtxos([utxo], true);
    expect(actual).toBe(
      '8282582022222222222222222222222222222222222222222222222222222222222222220182581d6111111111111111111111111111111111111111111111111111111111821a004c4b40a1581c44444444444444444444444444444444444444444444444444444444a1447465737407'
    );
    const [textOutput] = await transformCardanoUtxos([utxo], false);
    expect(textOutput.receiver).toBe(address.to_bech32());
  });

  test('resolves either full transaction CBOR or body CBOR for signing', async () => {
    await RustModule.load();
    const { txBodyHex, txHex } = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const inputs = cml.TransactionInputList.new();
      const outputs = cml.TransactionOutputList.new();
      outputs.add(
        cml.TransactionOutput.new(cml.Address.from_hex(`61${'11'.repeat(28)}`), cml.Value.from_coin(BigInt('5000000')))
      );
      const body = cml.TransactionBody.new(inputs, outputs, BigInt('170000'));
      const transaction = cml.Transaction.new(body, cml.TransactionWitnessSet.new(), true);
      return { txBodyHex: body.to_cbor_hex(), txHex: transaction.to_cbor_hex() };
    });
    const { resolveTxOrTxBody } = require('./api');

    for (const tx of [txHex, txBodyHex]) {
      const parsed = RustModule.WasmScope(Module => {
        const result = resolveTxOrTxBody({ tx }, Module);
        return { bodyHex: result.txBody.to_cbor_hex(), rawBodyHex: result.rawTxBody.toString('hex') };
      });
      expect(parsed.bodyHex).toBe(txBodyHex);
      expect(parsed.rawBodyHex).toBe(txBodyHex);
    }
  });

  test('extracts certificate signing hashes from CML credentials', async () => {
    await RustModule.load();
    const keyHashHex = '77'.repeat(28);
    const drepHashHex = '88'.repeat(28);
    const hashes = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const certificates = cml.CertificateList.new();
      certificates.add(
        cml.Certificate.new_stake_deregistration(cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(keyHashHex)))
      );
      certificates.add(
        cml.Certificate.new_reg_drep_cert(
          cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(drepHashHex)),
          BigInt('500000000')
        )
      );
      const body = cml.TransactionBody.new(cml.TransactionInputList.new(), cml.TransactionOutputList.new(), BigInt('0'));
      body.set_certs(certificates);
      const { getCertificatesRequiredSignKeys } = require('./api');
      return Array.from(getCertificatesRequiredSignKeys(body));
    });
    expect(hashes).toEqual([keyHashHex, drepHashHex]);
  });

  test('extracts required key hashes from CML native scripts', async () => {
    await RustModule.load();
    const keyHashHex = '99'.repeat(28);
    const hashes = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const nativeScripts = cml.NativeScriptList.new();
      nativeScripts.add(cml.NativeScript.new_script_pubkey(cml.Ed25519KeyHash.from_hex(keyHashHex)));
      const witnessSet = cml.TransactionWitnessSet.new();
      witnessSet.set_native_scripts(nativeScripts);
      const { getScriptRequiredSigningKeys } = require('./api');
      return Array.from(getScriptRequiredSigningKeys(witnessSet, Module));
    });
    expect(hashes).toEqual([keyHashHex]);
  });
});
