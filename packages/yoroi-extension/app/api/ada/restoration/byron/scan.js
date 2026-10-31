// @flow

// Handle restoring wallets that follow the v2 addressing scheme (bip44)

import type { GenerateAddressFunc } from '../../../common/lib/restoration/bip44AddressScan';

import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { hexToBytes } from '../../../../coreUtils';

import type { InsertRequest } from '../../lib/storage/database/walletTypes/common/utils.types';
import type { AddByHashFunc } from '../../../common/lib/storage/bridge/hashMapper';
import { CoreAddressTypes } from '../../lib/storage/database/primitives/enums';

export function v2genAddressBatchFunc(
  accountPublicKey: string,
  chainIndex: number,
  byronProtocolMagic: number
): GenerateAddressFunc {
  return (indices: Array<number>) => {
    return RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const protocolMagic = cml.ProtocolMagic.new(byronProtocolMagic);
      const accountKey = cml.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKey));
      const addressChain = accountKey.derive(chainIndex);
      return indices.map(index => {
        const cmlAddressKey = addressChain.derive(index);
        return cml.AddressContent.new_simple(cmlAddressKey, protocolMagic).to_address().to_base58();
      });
    });
  };
}

export async function addByronAddress(
  addByHash: AddByHashFunc,
  insertRequest: InsertRequest,
  address: string
): Promise<{|
  KeyDerivationId: number,
|}> {
  await addByHash({
    ...insertRequest,
    address: {
      type: CoreAddressTypes.CARDANO_LEGACY,
      data: address,
    },
  });
  return {
    KeyDerivationId: insertRequest.keyDerivationId,
  };
}
