import {
  addressHexToBech32 as addressHexToBech32WithCml,
  deriveRewardAddressFromAddress as deriveRewardAddressWithCml,
} from '../../api/ada/lib/cardanoCrypto/cmlAddress';
import { getNetworkById, getCardanoHaskellBaseConfigCombined } from '../../api/ada/lib/storage/database/prepackaged/networks';
import { truncateAddressShort, truncateAddress } from '../../utils/formatters';

export const deriveRewardAddressFromAddress = (address: string, networkId: number): string => {
  try {
    const network = getNetworkById(networkId);
    const networkConfig = getCardanoHaskellBaseConfigCombined(network);

    const rewardAddrAsAddress = deriveRewardAddressWithCml(address, networkConfig.ChainNetworkId);

    if (typeof rewardAddrAsAddress !== 'string') throw new Error('Its not possible to derive reward address');
    return rewardAddrAsAddress;
  } catch (error) {
    console.error('[deriveRewardAddressFromAddress] input=' + address, error);
    throw error;
  }
};

export function addressHexToBech32(hex: string): string {
  return addressHexToBech32WithCml(hex);
}

type Truncate = 'short' | 'long' | 'none';

export function displayAddrTruncated(addr: string, truncate: Truncate = 'none'): string {
  if (truncate === 'short') {
    return truncateAddressShort(addr);
  }

  if (truncate === 'long') {
    return truncateAddress(addr);
  }

  return addr;
}
