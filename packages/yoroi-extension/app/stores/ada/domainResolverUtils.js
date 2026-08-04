// @flow

import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';

export function isValidMainnetPaymentAddress(address: string): boolean {
  try {
    return RustModule.WasmScope(Scope => {
      const parsedAddress = Scope.WalletV4.Address.from_bech32(address);
      return parsedAddress.network_id() === 1 && Scope.WalletV4.RewardAddress.from_address(parsedAddress) == null;
    });
  } catch (_error) {
    return false;
  }
}
