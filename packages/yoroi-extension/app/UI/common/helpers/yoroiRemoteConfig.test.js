import { isYoroiRemoteConfig, parseYoroiRemoteConfig } from './yoroiRemoteConfig';

const validConfig = {
  pushLinkKeys: {
    internal: { mainnet: 'internal-key' },
    external: { mainnet: 'external-key' },
  },
  banners: {
    midnightAnnouncement: { display: true },
    earnRewardsWithYoroi: {
      display: false,
      poolId: 'pool1',
      poolName: 'Yoroi',
      drepId: 'drep1',
    },
  },
  popups: {
    firefoxSupportAnnouncement: { display: true },
    stakingUpdate: { display: false, affectedPools: ['pool1'] },
  },
  dapps: {
    recommended: [
      {
        id: 'dapp-1',
        name: 'DApp',
        description: 'Description',
        category: 'defi',
        logo: 'https://example.com/logo.png',
        uri: 'https://example.com',
        origins: ['https://example.com'],
      },
    ],
    banned: [],
    filters: { category: ['defi'] },
  },
  swap: {
    initialPair: { tokenIn: 'ada', tokenOut: 'token' },
    excludedTokens: [],
    verifiedTokens: ['token'],
    partners: { dex: 'partner' },
  },
  enableTrezorAirdrop: false,
};

test('accepts a valid remote config and preserves unknown future keys', () => {
  const config = { ...validConfig, futureSection: { enabled: true } };

  expect(parseYoroiRemoteConfig(config)).toBe(config);
});

test.each([
  null,
  [],
  { banners: { midnightAnnouncement: { display: 'yes' } } },
  { popups: { firefoxSupportAnnouncement: {} } },
  { dapps: { recommended: [], banned: [1] } },
  { swap: { initialPair: { tokenIn: 'ada' }, excludedTokens: [], verifiedTokens: [], partners: {} } },
  { enableTrezorAirdrop: 'false' },
])('rejects malformed remote config %#', value => {
  expect(isYoroiRemoteConfig(value)).toBe(false);
  expect(() => parseYoroiRemoteConfig(value)).toThrow('Invalid Yoroi remote config response');
});
