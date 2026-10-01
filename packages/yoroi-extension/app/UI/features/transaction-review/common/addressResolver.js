// @flow
import { RustModule } from '../../../../api/ada/lib/cardanoCrypto/rustLoader';
import { addressHexToBech32 } from '../../../../api/ada/lib/cardanoCrypto/cmlAddress';

export { addressHexToBech32 };

export const resolveAddress = (
  addressBech32: string | undefined
): {
  resolvedAddress: string | undefined,
  paymentCredKind: number | null,
} =>
  RustModule.WasmScope(Module => {
    if (addressBech32 == null) {
      return { resolvedAddress: addressBech32, paymentCredKind: null };
    }

    let address;
    try {
      address = Module.CML.Address.from_bech32(addressBech32);
    } catch {
      address = Module.CML.ByronAddress.from_base58(addressBech32).to_address();
    }

    if (address.kind() === Module.CML.AddressKind.Byron) {
      return {
        resolvedAddress: Module.CML.ByronAddress.from_address(address)?.to_base58(),
        paymentCredKind: null,
      };
    }
    return {
      resolvedAddress: addressBech32,
      paymentCredKind: address.payment_cred()?.kind() ?? null,
    };
  });
