// @flow
import '../../../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../../../api/ada/lib/cardanoCrypto/rustLoader';
import { useGetInputs } from './helpers';

beforeAll(async () => {
  await RustModule.load();
});

test('swap input conversion preserves legacy UTxO CBOR for ADA, assets, datum, and script references', async () => {
  const fixture = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const CML = Module.CML;
    const address = CSL.EnterpriseAddress.new(
      0,
      CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)))
    ).to_address().to_hex();
    const datum = CML.PlutusData.new_integer(CML.BigInteger.from_str('42'));
    const legacyScript = CSL.NativeScript.new_script_pubkey(
      CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex('22'.repeat(28)))
    );
    const scriptRef = CSL.ScriptRef.new_native_script(legacyScript);
    const policyId = CSL.ScriptHash.from_hex('44'.repeat(28));
    const assets = CSL.Assets.new();
    assets.insert(CSL.AssetName.new(Buffer.from('aabb', 'hex')), CSL.BigNum.from_str('3'));
    const multiAsset = CSL.MultiAsset.new();
    multiAsset.insert(policyId, assets);
    const value = CSL.Value.new(CSL.BigNum.from_str('2000000'));
    value.set_multiasset(multiAsset);
    const output = CSL.TransactionOutput.new(CSL.Address.from_hex(address), value);
    output.set_plutus_data(CSL.PlutusData.from_bytes(datum.to_cbor_bytes()));
    output.set_script_ref(scriptRef);
    const utxo = CSL.TransactionUnspentOutput.new(
      CSL.TransactionInput.new(CSL.TransactionHash.from_hex('33'.repeat(32)), 7),
      output
    );
    return {
      address,
      datumCborHex: datum.to_cbor_hex(),
      scriptRefCborHex: scriptRef.to_hex(),
      expected: utxo.to_hex(),
    };
  });
  const inputs = await useGetInputs([{
    address: fixture.address,
    output: {
      Transaction: { Hash: '33'.repeat(32) },
      UtxoTransactionOutput: { OutputIndex: 7 },
      tokens: [
        { Token: { Identifier: '.', Metadata: { ticker: 'ADA' } }, TokenList: { Amount: '2000000' } },
        { Token: { Identifier: '44'.repeat(28) + '.aabb', Metadata: { policyId: '44'.repeat(28), assetName: 'aabb' } }, TokenList: { Amount: '3' } },
      ],
      inlineDatumCborHex: fixture.datumCborHex,
      scriptRefCborHex: fixture.scriptRefCborHex,
    },
  }]).getInputs();
  expect(inputs).toEqual([fixture.expected]);
});
