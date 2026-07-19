// @flow

import { resolveDomainAddressFixture } from './domainResolverFixtures';
import developmentConfig from '../../../config/development.json';
import mainnetConfig from '../../../config/mainnet.json';
import shelleyTestnetConfig from '../../../config/shelley-testnet.json';
import testConfig from '../../../config/test.json';
import { Address } from '@emurgo/cardano-serialization-lib-nodejs';

const fixtures = {
  $fixture: {
    address: 'addr1fixture',
    nameServer: 'ADA Handle',
  },
};

describe('domain resolver fixtures', () => {
  test('leaves public provider resolution enabled when fixtures are not configured', () => {
    expect(resolveDomainAddressFixture('$fixture', undefined)).toBeUndefined();
  });

  test('returns a configured deterministic address', () => {
    expect(resolveDomainAddressFixture('$fixture', fixtures)).toEqual({
      address: 'addr1fixture',
      error: null,
      nameServer: 'ADA Handle',
    });
  });

  test('fails closed as not found when a deterministic fixture is missing', () => {
    expect(resolveDomainAddressFixture('$missing', fixtures)).toBeNull();
  });

  test('keeps deterministic fixtures test-only and covers every resolver', () => {
    expect(Object.keys(testConfig.app.domainResolverFixtures).sort()).toEqual([
      '$svinkopepo',
      'rahul.ada',
      'stackchain.blockchain',
    ]);
    expect(developmentConfig.app.domainResolverFixtures).toBeUndefined();
    expect(mainnetConfig.app.domainResolverFixtures).toBeUndefined();
    expect(shelleyTestnetConfig.app.domainResolverFixtures).toBeUndefined();

    const fixtureAddresses = Object.values(testConfig.app.domainResolverFixtures).map(fixture => fixture.address);
    expect(new Set(fixtureAddresses).size).toBe(3);
    for (const address of fixtureAddresses) {
      expect(Address.from_bech32(address).network_id()).toBe(1);
    }
  });
});
