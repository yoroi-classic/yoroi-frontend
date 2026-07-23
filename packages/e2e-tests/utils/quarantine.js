const runQuarantinedDAppTests = () => process.env.RUN_QUARANTINED_DAPP_TESTS === 'true';

const withReason = (title, reason) => `${title} [quarantined: ${reason}]`;

export const beforeQuarantinedDApp = reason => {
  before(`quarantine: ${reason}`, function () {
    if (runQuarantinedDAppTests()) {
      return;
    }

    this.skip();
  });
};

export const itQuarantinedDApp = (title, reason, fn) => {
  const itFn = runQuarantinedDAppTests() ? it : it.skip;
  return itFn(withReason(title, reason), fn);
};

const liveProviderReason = 'public resolvers are nondeterministic; owner @wolf31o2, expiry 2026-10-16, see yoroi-frontend#88';

export const describeQuarantinedLiveProvider = (title, fn) => {
  const describeFn = process.env.RUN_LIVE_PROVIDER_TESTS === 'true' ? describe : describe.skip;
  return describeFn(withReason(title, liveProviderReason), fn);
};
