const runQuarantinedDAppTests = () => process.env.RUN_QUARANTINED_DAPP_TESTS === 'true';

const withReason = (title, reason) => `${title} [quarantined: ${reason}]`;

export const itQuarantinedDApp = (title, reason, fn) => {
  const itFn = runQuarantinedDAppTests() ? it : it.skip;
  return itFn(withReason(title, reason), fn);
};
