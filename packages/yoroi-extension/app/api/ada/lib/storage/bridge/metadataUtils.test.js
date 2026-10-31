// @flow
import { RustModule } from '../../cardanoCrypto/rustLoader';
import { createMetadata, parseMetadata, parseMetadataDetailed } from './metadataUtils';
import '../../test-config.forTests';

describe('transaction metadata CML migration', () => {
  beforeAll(async () => {
    await RustModule.load();
  });

  it('encodes auxiliary metadata with CML basic conversions', () => {
    const metadata = [{ label: '674', data: { msg: 'hello', count: 42 } }];
    expect(createMetadata(metadata)).toEqual(Buffer.from('a11902a2a265636f756e74182a636d73676568656c6c6f', 'hex'));
  });

  it('decodes metadatum with CML basic and detailed schemas', () => {
    const metadatumHex = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const metadatum = cml.encode_json_str_to_metadatum(
        JSON.stringify({ msg: 'hello', count: 42 }),
        cml.MetadataJsonSchema.BasicConversions
      );
      return Buffer.from(metadatum.to_cbor_bytes()).toString('hex');
    });

    expect(JSON.parse(parseMetadata(metadatumHex))).toEqual({ msg: 'hello', count: 42 });
    const detailed = JSON.parse(parseMetadataDetailed(metadatumHex));
    expect(detailed.map).toHaveLength(2);
    expect(detailed.map).toContainEqual({ k: { string: 'msg' }, v: { string: 'hello' } });
    expect(detailed.map).toContainEqual({ k: { string: 'count' }, v: { int: 42 } });
  });
});
