// @flow

import BigNumber from 'bignumber.js';
import { RustModule } from '../../cardanoCrypto/rustLoader';
import { unwrapStakingKey } from './utils';
import { addressHasStakeCredential } from '../../cardanoCrypto/cmlAddress';
import type { IGetAllUtxosResponse } from '../models/PublicDeriver/interfaces';
import { MultiToken } from '../../../../common/lib/MultiToken';
import type { WalletState } from '../../../../../../chrome/extension/background/types';

export type GetDelegatedBalanceRequest = {|
  wallet: WalletState,
  rewardBalance: MultiToken,
  stakingAddress: string,
  delegation: string | null,
  allRewards: string | null,
  stakeRegistered: ?boolean,
|};
export type GetDelegatedBalanceResponse = {|
  utxoPart: MultiToken,
  accountPart: MultiToken,
  delegation: string | null,
  allRewards: string | null,
  stakeRegistered: ?boolean,
|};
export type GetDelegatedBalanceFunc = (request: GetDelegatedBalanceRequest) => Promise<GetDelegatedBalanceResponse>;
export type RewardHistoryRequest = string;
export type RewardHistoryResponse = Array<
  [
    number, // epoch
    MultiToken, // amount
    string, // poolHash
  ],
>;
export type RewardHistoryFunc = (request: RewardHistoryRequest) => Promise<RewardHistoryResponse>;

export async function getDelegatedBalance(request: GetDelegatedBalanceRequest): Promise<GetDelegatedBalanceResponse> {
  const utxoPart = await getUtxoDelegatedBalance(request.wallet, request.stakingAddress);

  return {
    utxoPart,
    accountPart: request.rewardBalance,
    delegation: request.delegation,
    allRewards: request.allRewards,
    stakeRegistered: request.stakeRegistered,
  };
}

export function addrContainsAccountKey(address: string, targetAccountKey: string, acceptTypeMismatch: boolean): boolean {
  try {
    return addressHasStakeCredential(address, targetAccountKey) || acceptTypeMismatch;
  } catch (_error) {
    throw new Error(`${nameof(addrContainsAccountKey)} invalid address ${address}`);
  }
}

export function filterAddressesByStakingKey<T: { +address: string, ... }>(
  stakingKey: string,
  utxos: $ReadOnlyArray<$ReadOnly<T>>,
  acceptTypeMismatch: boolean
): $ReadOnlyArray<$ReadOnly<T>> {
  const result = [];
  for (const utxo of utxos) {
    if (addrContainsAccountKey(utxo.address, stakingKey, acceptTypeMismatch)) {
      result.push(utxo);
    }
  }
  return result;
}

export async function getUtxoDelegatedBalance(wallet: WalletState, _stakingAddress: string): Promise<MultiToken> {
  // TODO: need to also deal with pointer address summing
  // can get most recent pointer from getCurrentDelegation result

  const stakingKey = unwrapStakingKey(wallet.stakingAddress);
  const allUtxo = wallet.utxos;
  const allUtxosForKey = filterAddressesByStakingKey<ElementOf<IGetAllUtxosResponse>>(stakingKey, allUtxo, false);
  const defaultToken = {
    defaultNetworkId: wallet.networkId,
    defaultIdentifier: wallet.defaultTokenId,
  };
  const defaultMultiToken = new MultiToken([], defaultToken);

  const utxoSum = allUtxosForKey.reduce(
    (sum, utxo) =>
      sum.joinAddMutable(
        new MultiToken(
          utxo.output.tokens.map(token => ({
            identifier: token.Token.Identifier,
            amount: new BigNumber(token.TokenList.Amount),
            networkId: token.Token.NetworkId,
          })),
          defaultToken
        )
      ),
    defaultMultiToken
  );

  return utxoSum;
}

export const DREP_ALWAYS_ABSTAIN = 'ALWAYS_ABSTAIN';
export const DREP_ALWAYS_NO_CONFIDENCE = 'ALWAYS_NO_CONFIDENCE';

function parseDrep(CML: any, drepCredential: string): any {
  if (drepCredential === DREP_ALWAYS_ABSTAIN) return CML.DRep.new_always_abstain();
  if (drepCredential === DREP_ALWAYS_NO_CONFIDENCE) return CML.DRep.new_always_no_confidence();
  const credential = CML.Credential.from_cbor_hex(drepCredential);
  const keyHash = credential.as_pub_key();
  if (keyHash != null) return CML.DRep.new_key(keyHash);
  const scriptHash = credential.as_script();
  if (scriptHash != null) return CML.DRep.new_script(scriptHash);
  throw new Error('Credential cannot be converted into a DRep: ' + credential.to_cbor_hex());
}

export function createCertificate(
  stakingKeyHashHex: string,
  isRegistered: boolean,
  poolRequest: void | string,
  drepCredential: void | string
): Array<string> {
  return RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const credential = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(stakingKeyHashHex));
    if (poolRequest == null && drepCredential == null) {
      if (isRegistered) {
        return [CML.Certificate.new_stake_deregistration(credential).to_cbor_hex()];
      }
      return []; // no need to undelegate if no staking key registered
    }
    const result = [];
    if (!isRegistered) {
      // if unregistered, need to register first
      result.push(CML.Certificate.new_stake_registration(credential).to_cbor_hex());
    }
    if (poolRequest != null) {
      result.push(CML.Certificate.new_stake_delegation(credential, CML.Ed25519KeyHash.from_hex(poolRequest)).to_cbor_hex());
    }
    if (drepCredential != null) {
      result.push(CML.Certificate.new_vote_deleg_cert(credential, parseDrep(CML, drepCredential)).to_cbor_hex());
    }
    return result;
  });
}

export function stakeDeregistrationCertificateFromRewardAddress(rewardAddressHex: string): string {
  return RustModule.WasmScope(Module => {
    const address = Module.CML.Address.from_hex(rewardAddressHex);
    const rewardAddress = Module.CML.RewardAddress.from_address(address);
    if (rewardAddress == null) throw new Error(`${nameof(stakeDeregistrationCertificateFromRewardAddress)} not a reward address`);
    const credential = rewardAddress.payment();
    if (credential.as_pub_key() == null) throw new Error('Unexpected: withdrawal from a script hash');
    return Module.CML.Certificate.new_stake_deregistration(credential).to_cbor_hex();
  });
}
