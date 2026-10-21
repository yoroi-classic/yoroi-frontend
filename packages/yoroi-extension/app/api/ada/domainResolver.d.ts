type ResolverResult = {
  nameServer: string | null;
  address: string | null;
  error: { name?: string } | null;
};

type ResolverApi = {
  getCardanoAddresses(
    request: { resolve: string; strategy?: 'all' | 'first' },
    fetcherConfig?: unknown
  ): Promise<Array<ResolverResult>>;
};

export function isResolvableDomain(resolve: string): boolean;
export function resolverApiMaker(
  options: { apiConfig?: Record<string, { apiKey?: string }>; isMainnet?: boolean },
  fetchers?: object
): ResolverApi;
