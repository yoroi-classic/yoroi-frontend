// @flow
import { RustModule } from '../../cardanoCrypto/rustLoader';
import { createMetadata, parseMetadata, parseMetadataDetailed } from './metadataUtils';
import '../../test-config.forTests';

describe('transaction metadata CML migration', () => {
  beforeAll(async () => {
    await RustModule.load();
  });

  it('encodes auxiliary metadata identically to CSL basic conversions', () => {
    const metadata = [{ label: '674', data: { msg: 'hello', count: 42 } }];
    const expected = RustModule.WasmScope(Module => {
      const values = Module.WalletV4.GeneralTransactionMetadata.new();
      const metadatum = Module.WalletV4.encode_json_str_to_metadatum(
        JSON.stringify(metadata[0].data),
        Module.WalletV4.MetadataJsonSchema.BasicConversions
      );
      values.insert(Module.WalletV4.BigNum.from_str(metadata[0].label), metadatum);
      const auxiliaryData = Module.WalletV4.AuxiliaryData.new();
      auxiliaryData.set_metadata(values);
      return Buffer.from(auxiliaryData.to_bytes());
    });

    expect(createMetadata(metadata)).toEqual(expected);
  });

  it('decodes metadatum with CML basic and detailed schemas', () => {
    const metadatumHex = RustModule.WasmScope(Module => {
      const metadatum = Module.WalletV4.encode_json_str_to_metadatum(
        JSON.stringify({ msg: 'hello', count: 42 }),
        Module.WalletV4.MetadataJsonSchema.BasicConversions
      );
      return metadatum.to_hex();
    });

    expect(JSON.parse(parseMetadata(metadatumHex))).toEqual({ msg: 'hello', count: 42 });
    const detailed = JSON.parse(parseMetadataDetailed(metadatumHex));
    expect(detailed.map).toHaveLength(2);
    expect(detailed.map).toContainEqual({ k: { string: 'msg' }, v: { string: 'hello' } });
    expect(detailed.map).toContainEqual({ k: { string: 'count' }, v: { int: 42 } });
  });
});
