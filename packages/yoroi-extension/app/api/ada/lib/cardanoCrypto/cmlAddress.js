// @flow
import { RustModule } from './rustLoader';

export const addressHexToBech32 = (addressHex: string): string =>
  RustModule.WasmScope(Module => Module.CML.Address.from_hex(addressHex).to_bech32());

export const addressBech32ToHex = (addressBech32: string): string =>
  RustModule.WasmScope(Module => Module.CML.Address.from_bech32(addressBech32).to_hex());

export const deriveRewardAddressFromAddress = (address: string, networkId: number): string =>
  RustModule.WasmScope(Module => {
    const baseAddress = Module.CML.BaseAddress.from_address(Module.CML.Address.from_bech32(address));
    const stakeCredential = baseAddress?.stake();
    if (stakeCredential == null) throw new Error('Address has no stake credential');
    return Module.CML.RewardAddress.new(networkId, stakeCredential)
      .to_address()
      .to_bech32();
  });
