import { useQuery } from '@tanstack/react-query';
import { RustModule } from '../../../../../api/ada/lib/cardanoCrypto/rustLoader';
import { TransactionBody } from '../types';

export const useTxBody = ({
  cbor,
  unsignedTx,
}: {
  cbor?: string | null;
  unsignedTx?: Uint8Array | null;
}): TransactionBody | { body: TransactionBody } | undefined => {
  const query = useQuery({
    queryKey: ['useTxBody', cbor, unsignedTx],
    queryFn: async () => {
      if (cbor && typeof cbor === 'string') {
        return getCborTxBody(cbor);
      }

      if (unsignedTx != null) {
        return getUnsignedTxTxBody(unsignedTx);
      }

      throw new Error('useTxBody: missing both cbor and unsignedTx');
    },
    enabled: Boolean(cbor || unsignedTx),
  });

  return query.data;
};

export const getCborTxBody = async (cbor: string): Promise<TransactionBody> => {
  try {
    return RustModule.WasmScope(Module => {
      const body = Module.CML.Transaction.from_cbor_hex(cbor).body();
      const txBody = JSON.parse(body.to_json()) as TransactionBody;

      // CML's JSON serializer emits coin quantities as JSON numbers. Convert them
      // from the integer accessors instead so JSON.parse cannot round Lovelace or
      // token quantities above Number.MAX_SAFE_INTEGER.
      txBody.fee = body.fee().toString();
      const outputs = body.outputs();
      txBody.outputs = Array.from({ length: outputs.len() }, (_, index) => {
        const output = outputs.get(index);
        const amount = output.amount();
        const multiAsset = amount.multi_asset();
        const formattedAssets = {};

        if (multiAsset != null) {
          const policyIds = multiAsset.keys();
          for (let policyIndex = 0; policyIndex < policyIds.len(); policyIndex++) {
            const policyId = policyIds.get(policyIndex);
            const assets = multiAsset.get_assets(policyId);
            if (assets == null) continue;
            const assetNames = assets.keys();
            const formattedPolicyAssets = {};

            for (let assetIndex = 0; assetIndex < assetNames.len(); assetIndex++) {
              const assetName = assetNames.get(assetIndex);
              const quantity = assets.get(assetName);
              if (quantity == null) continue;
              formattedPolicyAssets[assetName.to_hex()] = quantity.toString();
            }

            formattedAssets[policyId.to_hex()] = formattedPolicyAssets;
          }
        }

        const address = output.address();
        const byronAddress = Module.CML.ByronAddress.from_address(address);
        return {
          address: byronAddress?.to_base58() ?? address.to_bech32(),
          amount: {
            coin: amount.coin().toString(),
            multiasset: Object.keys(formattedAssets).length === 0 ? null : formattedAssets,
          },
        };
      });

      return txBody;
    });
  } catch (e) {
    console.warn('getCborTxBody failed:', e);
    throw e;
  }
};

export const getUnsignedTxTxBody = async (unsignedTx: Uint8Array) => {
  const transactionHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const body = cml.TransactionBody.from_cbor_bytes(unsignedTx);
    return cml.Transaction.new(body, cml.TransactionWitnessSet.new(), true).to_cbor_hex();
  });
  return { body: await getCborTxBody(transactionHex) };
};
