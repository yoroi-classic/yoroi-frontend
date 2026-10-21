import axios from 'axios';
import '../test-config.forTests';
import CmlGovernanceApi from './cmlGovernanceApi';
import { RustModule } from './rustLoader';

jest.mock('axios');

describe('CmlGovernanceApi', () => {
  beforeAll(async () => RustModule.load());
  beforeEach(() => jest.clearAllMocks());

  it('requests stake, DRep, and reward state using the CML reward address', async () => {
    const stakeHash = '11'.repeat(28);
    const rewardAddress = RustModule.WasmScope(Module => {
      const keyHash = Module.CML.Ed25519KeyHash.from_hex(stakeHash);
      return Module.CML.RewardAddress.new(0, Module.CML.Credential.new_pub_key(keyHash)).to_address().to_hex();
    });
    const stake = { registration: { deposit: '2000000' }, poolDelegation: { pool: 'pool1' }, drepDelegation: null };
    const drep = { registration: { deposit: '5000000' } };
    axios.get.mockImplementation(async url => ({ data: url.includes('/stakekeys/') ? stake : drep }));
    axios.post.mockResolvedValue({
      data: { [rewardAddress]: { remainingAmount: '42', remainingNonSpendableAmount: '0', rewards: [], withdrawals: [] } },
    });

    const api = new CmlGovernanceApi({
      oldBackendUrl: 'https://old.example',
      newBackendUrl: 'https://new.example',
      networkId: 0,
    });
    await expect(api.getAccountState(stakeHash, '22'.repeat(28))).resolves.toEqual({
      stakeRegistration: stake.registration,
      stakeDelegation: stake.poolDelegation,
      stakeDeregistration: null,
      drepRegistration: drep.registration,
      drepDelegation: null,
      drepDeregistration: null,
      rewardsStatus: { remainingAmount: '42', remainingNonSpendableAmount: '0', rewards: [], withdrawals: [] },
    });

    expect(axios.get).toHaveBeenCalledWith(`/stakekeys/${stakeHash}/state`, { baseURL: 'https://new.example' });
    expect(axios.get).toHaveBeenCalledWith(`/dreps/${'22'.repeat(28)}/state`, { baseURL: 'https://new.example' });
    expect(axios.post).toHaveBeenCalledWith(
      '/api/account/state',
      { addresses: [rewardAddress] },
      {
        headers: { 'Content-Type': 'application/json' },
        baseURL: 'https://old.example',
      }
    );
  });

  it('treats missing stake and DRep records as empty states', async () => {
    axios.get.mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
    axios.isAxiosError.mockReturnValue(true);
    axios.post.mockResolvedValue({ data: {} });
    const api = new CmlGovernanceApi({ oldBackendUrl: 'old', newBackendUrl: 'new', networkId: 0 });

    await expect(api.getAccountState('11'.repeat(28), '22'.repeat(28))).resolves.toEqual({
      stakeRegistration: null,
      stakeDelegation: null,
      stakeDeregistration: null,
      drepRegistration: null,
      drepDelegation: null,
      drepDeregistration: null,
      rewardsStatus: null,
    });
  });

  it('propagates non-404 backend failures', async () => {
    const error = { isAxiosError: true, response: { status: 500 } };
    axios.get.mockRejectedValue(error);
    axios.isAxiosError.mockReturnValue(true);
    axios.post.mockResolvedValue({ data: {} });
    const api = new CmlGovernanceApi({ oldBackendUrl: 'old', newBackendUrl: 'new', networkId: 0 });

    await expect(api.getAccountState('11'.repeat(28), '22'.repeat(28))).rejects.toBe(error);
  });
});
