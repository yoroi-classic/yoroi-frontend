// @flow

import type { DomainResolverFixtures } from '../../../config/config-types';

export type DomainResolverFixtureResult = {|
  address: ?string,
  error: ?('forbidden' | 'unexpected'),
  nameServer: string,
|};

/**
 * An absent fixture map keeps normal provider resolution enabled. Once a map
 * is configured, missing names resolve deterministically as not found instead
 * of falling through to a public provider.
 */
export function resolveDomainAddressFixture(
  domain: string,
  fixtures: void | DomainResolverFixtures
): void | null | DomainResolverFixtureResult {
  if (fixtures == null) return undefined;

  if (!Object.prototype.hasOwnProperty.call(fixtures, domain)) return null;
  const fixture = fixtures[domain];

  return {
    address: fixture.address,
    error: null,
    nameServer: fixture.nameServer,
  };
}
