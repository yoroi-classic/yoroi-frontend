// @flow

import '../../../app/api/ada/lib/test-config.forTests';
import { RustModule } from '../../../app/api/ada/lib/cardanoCrypto/rustLoader';

let persistedTransactions: any = null;

const mockConnectorDependencies = () => {
  jest.doMock('../../../app/api/ada/lib/storage/models/PublicDeriver/traits', () => {
    const actual = jest.requireActual('../../../app/api/ada/lib/storage/models/PublicDeriver/traits');
    return {
      ...actual,
      asGetAllUtxos: wallet => ({
        getAllUtxoAddresses: async () => wallet.testAddresses ?? [],
        getAllUtxos: async () => wallet.testUtxos,
      }),
      asHasUtxoChains: utxos => ({ getAllUtxos: async () => utxos.getAllUtxos() }),
    };
  });
  jest.doMock('../../../app/api/localStorage', () => {
    const actual = jest.requireActual('../../../app/api/localStorage');
    return {
      ...actual,
      loadSubmittedTransactions: async () => [],
      persistSubmittedTransactions: async transactions => {
        persistedTransactions = transactions;
      },
    };
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
        addressedUtxosWithSubmittedTxs(utxos) {
          return utxos;
        }
      },
    };
  });
};

describe('connectorGetUtxosCardano CML selection', () => {
  test('preserves a transaction witness set when signing through the connector', async () => {
    await RustModule.load();
    mockConnectorDependencies();
    const cml = RustModule.WasmScope(Module => Module.CML);
    const signing = require('../../../app/api/ada/transactions/shelley/transactions');
    const signSpy = jest.spyOn(signing, 'signTransactionFromWallet');
    signSpy.mockImplementation(async (utxos, bodyBytes, _wallet, _password, _metadata, _signers, witnessSet) => {
      expect(utxos).toEqual([]);
      expect(witnessSet).toEqual(expectedWitnessSet);
      return signedTxBytes;
    });
    const witnessSetBytes = [0xa1, 0x00, 0x81, 0x82, 0x58, 0x20, ...Array(32).fill(0x11), 0x58, 0x40, ...Array(64).fill(0x22)];
    const expectedWitnessSet = Uint8Array.from(witnessSetBytes);
    const body = cml.TransactionBody.new(cml.TransactionInputList.new(), cml.TransactionOutputList.new(), BigInt('0'));
    const transaction = cml.Transaction.from_cbor_bytes(
      Uint8Array.from([
        ...cml.Transaction.new(body, cml.TransactionWitnessSet.from_cbor_bytes(expectedWitnessSet), true).to_cbor_bytes(),
      ])
    );
    const signedTxBytes = transaction.to_cbor_bytes();

    const { connectorSignCardanoTx } = require('./api');
    try {
      const result = await connectorSignCardanoTx(({ publicDeriverId: 1, testUtxos: [] }: any), 'test-password', {
        tx: transaction.to_cbor_hex(),
      });
      expect(result).toBe(cml.TransactionWitnessSet.from_cbor_bytes(expectedWitnessSet).to_cbor_hex());
    } finally {
      signSpy.mockRestore();
    }
  });

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
    mockConnectorDependencies();
    const { connectorGetUtxosCardano } = require('./api');
    const result = await connectorGetUtxosCardano(
      ({ publicDeriverId: 1, testUtxos: dbUtxos }: any),
      fixture.valueHex,
      null,
      '4310'
    );

    expect(result).toHaveLength(2);
    expect(result.every(utxo => utxo.assets.some(asset => asset.assetId === tokenId))).toBe(true);
  });

  test('records submitted DRep delegation transactions with the delegation flag', async () => {
    await RustModule.load();
    const sourceTxHex = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const outputs = cml.TransactionOutputList.new();
      outputs.add(
        cml.TransactionOutput.new(cml.Address.from_hex(`61${'11'.repeat(28)}`), cml.Value.from_coin(BigInt('2000000')))
      );
      const stakeCredential = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('22'.repeat(28)));
      const certificates = cml.CertificateList.new();
      certificates.add(
        cml.Certificate.new_vote_deleg_cert(stakeCredential, cml.DRep.new_key(cml.Ed25519KeyHash.from_hex('33'.repeat(28))))
      );
      const body = cml.TransactionBody.new(cml.TransactionInputList.new(), outputs, BigInt('170000'));
      body.set_certs(certificates);
      return cml.Transaction.new(body, cml.TransactionWitnessSet.new(), true).to_cbor_hex();
    });
    const network = require('../../../app/api/ada/lib/storage/database/prepackaged/networks').networks.CardanoMainnet;
    const publicDeriver: any = {
      publicDeriverId: 1,
      getParent: () => ({
        defaultToken: { NetworkId: network.NetworkId, Identifier: 'ada' },
        getNetworkInfo: () => network,
      }),
    };
    persistedTransactions = null;
    mockConnectorDependencies();

    await require('./api').connectorRecordSubmittedCardanoTransaction(publicDeriver, sourceTxHex, []);

    expect(persistedTransactions).toHaveLength(1);
    expect(((persistedTransactions: any)[0]: any).isDrepDelegation).toBe(true);
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
        const result = resolveTxOrTxBody(({ tx }: any), Module);
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

  test('extracts DRep vote key hashes required to sign a transaction', async () => {
    await RustModule.load();
    const drepHashHex = 'aa'.repeat(28);
    const hashes = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const voter = cml.Voter.new_d_rep_key_hash(cml.Ed25519KeyHash.from_hex(drepHashHex));
      const actionId = cml.GovActionId.new(cml.TransactionHash.from_hex('bb'.repeat(32)), BigInt('0'));
      const proceduresByAction = cml.MapGovActionIdToVotingProcedure.new();
      proceduresByAction.insert(actionId, cml.VotingProcedure.new(cml.Vote.Yes, undefined));
      const procedures = cml.VotingProcedures.new();
      procedures.insert(voter, proceduresByAction);
      const body = cml.TransactionBody.new(cml.TransactionInputList.new(), cml.TransactionOutputList.new(), BigInt('0'));
      body.set_voting_procedures(procedures);
      const { getCertificatesRequiredSignKeys } = require('./api');
      return Array.from(getCertificatesRequiredSignKeys(body));
    });
    expect(hashes).toEqual([drepHashHex]);
  });

  test('includes collateral inputs when resolving wallet UTxOs to sign', async () => {
    await RustModule.load();
    const inputIds = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const regular = cml.TransactionInputList.new();
      regular.add(cml.TransactionInput.new(cml.TransactionHash.from_hex('11'.repeat(32)), BigInt('0')));
      const collateral = cml.TransactionInputList.new();
      collateral.add(cml.TransactionInput.new(cml.TransactionHash.from_hex('22'.repeat(32)), BigInt('1')));
      const body = cml.TransactionBody.new(regular, cml.TransactionOutputList.new(), BigInt('0'));
      body.set_collateral_inputs(collateral);
      return Array.from(require('./api').getTxInputUtxoIds(body));
    });
    expect(inputIds).toEqual([`${'11'.repeat(32)}0`, `${'22'.repeat(32)}1`]);
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
