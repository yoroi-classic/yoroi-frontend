export function addressBech32ToHex(addressBech32: string): string;
export function addressHexToBech32(addressHex: string): string;
export function deriveRewardAddressFromAddress(address: string, networkId: number): string;
export function poolKeyHashHexToBech32(poolKeyHashHex: string): string;
export function stakingKeyHashFromRewardAddress(stakingAddressHex: string): string | null;
