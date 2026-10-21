// @flow

import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';

export type SwapCmlTransaction = {|
  bodyBytes: Uint8Array,
  inputRefs: Array<{| txHash: string, index: number |}>,
  metadataBytes: void | Uint8Array,
|};

export function extractSwapCmlTransaction(cborHex: string): SwapCmlTransaction {
  return RustModule.WasmScope(Module => {
    const tx = Module.CML.Transaction.from_cbor_hex(cborHex);
    const body = tx.body();
    const inputs = body.inputs();
    const inputRefs = Array.from({ length: inputs.len() }, (_, index) => {
      const input = inputs.get(index);
      return { txHash: input.transaction_id().to_hex(), index: Number(input.index()) };
    });
    const auxiliaryData = tx.auxiliary_data();
    return {
      bodyBytes: body.to_cbor_bytes(),
      inputRefs,
      metadataBytes: auxiliaryData == null ? undefined : auxiliaryData.to_cbor_bytes(),
    };
  });
}
