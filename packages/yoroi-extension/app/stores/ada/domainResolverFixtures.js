// @flow

export type DomainResolverFixture = {|
  address: string,
  nameServer: string,
|};

export type DomainResolverFixtures = {|
  [domain: string]: DomainResolverFixture,
|};

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

  const fixture = fixtures[domain];
  if (fixture == null) return null;

  return {
    address: fixture.address,
    error: null,
    nameServer: fixture.nameServer,
  };
}
