// @flow

import { RustModule } from './rustLoader';
import { baseAddressesFromKeyHashes } from './cmlAddress';
import type { GenerateAddressFunc } from '../../../common/lib/restoration/bip44AddressScan';
import {
  ChainDerivations,
  CoinTypes,
  HARD_DERIVATION_START,
  STAKING_KEY_INDEX,
  WalletTypePurpose,
} from '../../../../config/numbersConfig';
import type { WalletChecksum } from '@yoroi-classic/cip4-js';
import { walletChecksum } from '@yoroi-classic/cip4-js';
import { bytesToHex } from '../../../../coreUtils';

export type PlateResponse = {|
  addresses: Array<string>,
  plate: WalletChecksum,
|};

export const generateShelleyPlate = (
  rootPk: RustModule.CML.Bip32PrivateKey,
  accountIndex: number,
  count: number,
  chainNetworkId: number
): PlateResponse => {
  const accountKey = rootPk
    .derive(WalletTypePurpose.CIP1852)
    .derive(CoinTypes.CARDANO)
    .derive(accountIndex + HARD_DERIVATION_START);
  const accountPublic = accountKey.to_public();
  const chainKey = accountPublic.derive(ChainDerivations.EXTERNAL);

  const stakingKey = accountPublic.derive(ChainDerivations.CHIMERIC_ACCOUNT).derive(STAKING_KEY_INDEX).to_raw_key();

  const plate = walletChecksum(bytesToHex(accountPublic.to_raw_bytes()));
  const generateAddressFunc = genBaseAddressBatchFunc(chainKey, stakingKey, chainNetworkId);
  const addresses = generateAddressFunc([...Array(count).keys()]);
  return { addresses, plate };
};

export function genBaseAddressBatchFunc(
  addressChain: RustModule.CML.Bip32PublicKey,
  stakingKey: RustModule.CML.PublicKey,
  chainNetworkId: number
): GenerateAddressFunc {
  return (indices: Array<number>) => {
    const stake = stakingKey.hash().to_hex();
    const keyHashes = indices.map(i => {
      const addressKey = addressChain.derive(i).to_raw_key();
      return { payment: addressKey.hash().to_hex(), stake };
    });
    return baseAddressesFromKeyHashes(chainNetworkId, keyHashes);
  };
}
