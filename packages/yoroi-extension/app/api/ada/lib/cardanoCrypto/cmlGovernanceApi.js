import axios from 'axios';
import { RustModule } from './rustLoader';

// Extension-owned replacement for the governance API in yoroi-lib. Keeping
// this boundary local avoids yoroi-lib's CrossCsl-backed WasmScope.
export default class CmlGovernanceApi {
  constructor({ oldBackendUrl, newBackendUrl, networkId }) {
    this.oldBackendUrl = oldBackendUrl;
    this.newBackendUrl = newBackendUrl;
    this.networkId = networkId;
  }

  async getDrepState(drepKeyHashHex) {
    try {
      const { data } = await axios.get(`/dreps/${drepKeyHashHex}/state`, { baseURL: this.newBackendUrl });
      return data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return {};
      throw error;
    }
  }

  async getStakingState(stakeKeyHashHex) {
    try {
      const { data } = await axios.get(`/stakekeys/${stakeKeyHashHex}/state`, { baseURL: this.newBackendUrl });
      return data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return {};
      throw error;
    }
  }

  async getRewardsState(stakeKeyHashHex) {
    const address = RustModule.WasmScope(Module => {
      const CML = Module.CML;
      const stakeCredential = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(stakeKeyHashHex));
      return CML.RewardAddress.new(this.networkId, stakeCredential).to_address().to_hex();
    });
    const { data } = await axios.post('/api/account/state', { addresses: [address] }, {
      headers: { 'Content-Type': 'application/json' },
      baseURL: this.oldBackendUrl,
    });
    const rewards = data[address];
    if (!rewards) return null;
    return {
      remainingAmount: rewards.remainingAmount,
      remainingNonSpendableAmount: rewards.remainingNonSpendableAmount,
      rewards: rewards.rewards,
      withdrawals: rewards.withdrawals,
    };
  }

  async getAccountState(stakeKeyHashHex, drepKeyHashHex) {
    const [stakeState, drepState, rewardsStatus] = await Promise.all([
      this.getStakingState(stakeKeyHashHex),
      this.getDrepState(drepKeyHashHex),
      this.getRewardsState(stakeKeyHashHex),
    ]);
    const isRegistered = 'registration' in stakeState;
    return {
      stakeRegistration: isRegistered ? stakeState.registration : null,
      stakeDelegation: isRegistered ? stakeState.poolDelegation : null,
      stakeDeregistration: 'deregistration' in stakeState ? stakeState.deregistration : null,
      drepRegistration: 'registration' in drepState ? drepState.registration : null,
      drepDelegation: isRegistered ? stakeState.drepDelegation : null,
      drepDeregistration: 'deregistration' in drepState ? drepState.deregistration : null,
      rewardsStatus,
    };
  }
}
