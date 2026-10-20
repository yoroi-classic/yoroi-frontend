// @flow
import { RustModule } from '../../cardanoCrypto/rustLoader';
import { isHex } from '../../../../../utils/hex';

export type TransactionMetadata = {|
  label: string,
  data: { ... },
|};

// Keep the existing to_bytes() boundary expected by transaction code, while
// ensuring all metadata parsing and encoding is performed by CML.
export function createMetadata(metadata: Array<TransactionMetadata>): Uint8Array {
  return RustModule.WasmScope(Module => {
    const transactionMetadata = Module.CML.Metadata.new();

    metadata.forEach((meta: TransactionMetadata) => {
      const metadatum = Module.CML.encode_json_str_to_metadatum(
        JSON.stringify(meta.data),
        Module.CML.MetadataJsonSchema.BasicConversions
      );
      // eslint-disable-next-line no-undef
      transactionMetadata.set(BigInt(meta.label), metadatum);
    });

    const auxData = Module.CML.AuxiliaryData.new_shelley(transactionMetadata);
    const bytes = Buffer.from(auxData.to_cbor_bytes());
    auxData.free();
    transactionMetadata.free();
    return bytes;
  });
}

export function parseMetadata(s: any): string {
  if (isHex(s)) {
    return RustModule.WasmScope(Module => {
      const metadatum = Module.CML.TransactionMetadatum.from_cbor_bytes(Buffer.from(s, 'hex'));
      const metadataString = Module.CML.decode_metadatum_to_json_str(
        metadatum,
        Module.CML.MetadataJsonSchema.BasicConversions
      );
      metadatum.free();
      return metadataString;
    });
  }
  return JSON.stringify(s);
}

export function parseMetadataDetailed(s: any): string {
  if (isHex(s)) {
    return RustModule.WasmScope(Module => {
      const metadatum = Module.CML.TransactionMetadatum.from_cbor_bytes(Buffer.from(s, 'hex'));
      const metadataString = Module.CML.decode_metadatum_to_json_str(
        metadatum,
        Module.CML.MetadataJsonSchema.DetailedSchema
      );
      metadatum.free();
      return metadataString;
    });
  }
  return JSON.stringify(s);
}
