import axios from 'axios';
import './lib/test-config.forTests';
import { RustModule } from './lib/cardanoCrypto/rustLoader';
import { getPoolTransition } from './poolTransition';

jest.mock('axios');

describe('getPoolTransition', () => {
  const currentHash = '11'.repeat(28);
  const firstCandidate = '33'.repeat(28);
  const secondCandidate = '44'.repeat(28);

  beforeAll(async () => RustModule.load());
  beforeEach(() => jest.clearAllMocks());

  it('uses CML pool-id encoding and selects the first candidate below saturation threshold', async () => {
    const currentId = RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(currentHash).to_bech32('pool'));
    const firstCandidateId = RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(firstCandidate).to_bech32('pool'));
    const secondCandidateId = RustModule.WasmScope(Module =>
      Module.CML.Ed25519KeyHash.from_hex(secondCandidate).to_bech32('pool')
    );
    const transitionInfo = {
      old: { group: [[currentId, 123456, true]] },
      new: { group: [firstCandidateId, secondCandidateId] },
      saturationThreshold: 0.8,
    };
    axios.get.mockResolvedValue({ status: 200, data: transitionInfo });
    axios.post.mockImplementation(async (_url, formData) => {
      const hash = new URLSearchParams(formData).get('search');
      const saturation = hash === firstCandidateId ? '0.9' : hash === secondCandidateId ? '0.7' : '0.4';
      const id = hash === currentHash ? currentId : `pool-${hash}`;
      return {
        data: {
          pools: {
            result: {
              id_bech: id,
              id: hash,
              db_ticker: 'TEST',
              db_name: 'Test Pool',
              pool_pic: false,
              total_stake: '100',
              total_size: 1000,
              roa: 0.05,
              saturation,
              tax_fix: '0',
              tax_ratio: '0.03',
            },
          },
        },
      };
    });

    await expect(getPoolTransition('https://backend.example/api', currentHash, 'mainnet')).resolves.toMatchObject({
      current: { hash: currentHash, ticker: 'TEST', pic: null },
      suggested: { hash: secondCandidateId, saturation: '0.7' },
      deadlineMilliseconds: 123456,
    });
    expect(axios.get).toHaveBeenCalledWith('/v2.1/pools/poolTransitionInfo', { baseURL: 'https://backend.example/api' });
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(axios.post).toHaveBeenCalledWith('https://a.cexplorer.io/yoroi-api/', expect.any(String), expect.any(Object));
  });

  it('uses the preprod explorer for preprod wallets', async () => {
    const currentId = RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(currentHash).to_bech32('pool'));
    axios.get.mockResolvedValue({
      status: 200,
      data: { old: { group: [[currentId, 123456, true]] }, new: { group: [] } },
    });
    axios.post.mockResolvedValue({ data: { pools: {} } });

    await expect(getPoolTransition('https://preprod-backend.example/api', currentHash, 'preprod')).resolves.toBeNull();
    expect(axios.post).toHaveBeenCalledWith('https://preprod.cexplorer.io/yoroi-api/', expect.any(String), expect.any(Object));
  });

  it('does not recommend a disabled old pool', async () => {
    const currentId = RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(currentHash).to_bech32('pool'));
    axios.get.mockResolvedValue({
      status: 200,
      data: { old: { group: [[currentId, 123, false]] }, new: { group: [firstCandidate] } },
    });

    await expect(getPoolTransition('https://backend.example/api', currentHash, 'mainnet')).resolves.toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns null when the explorer has no pool result', async () => {
    const currentId = RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(currentHash).to_bech32('pool'));
    const candidateId = RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(firstCandidate).to_bech32('pool'));
    axios.get.mockResolvedValue({
      status: 200,
      data: { old: { group: [[currentId, 123456, true]] }, new: { group: [candidateId] } },
    });
    axios.post.mockResolvedValue({ data: { pools: {} } });

    await expect(getPoolTransition('https://backend.example/api', currentHash, 'mainnet')).resolves.toBeNull();
  });

  it('does not recommend a candidate when every pool is above saturation', async () => {
    const currentId = RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(currentHash).to_bech32('pool'));
    const candidateId = RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(firstCandidate).to_bech32('pool'));
    axios.get.mockResolvedValue({
      status: 200,
      data: { old: { group: [[currentId, 123456, true]] }, new: { group: [candidateId] } },
    });
    axios.post.mockImplementation(async (_url, formData) => {
      const hash = new URLSearchParams(formData).get('search');
      return {
        data: {
          pools: {
            result: {
              id_bech: hash === currentHash ? currentId : candidateId,
              id: hash,
              db_ticker: 'TEST',
              db_name: 'Test Pool',
              pool_pic: false,
              total_stake: '100',
              total_size: 1000,
              roa: 0.05,
              saturation: '0.9',
              tax_fix: '0',
              tax_ratio: '0.03',
            },
          },
        },
      };
    });

    await expect(getPoolTransition('https://backend.example/api', currentHash, 'mainnet')).resolves.toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});
