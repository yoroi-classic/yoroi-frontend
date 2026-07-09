describe('CardanoAPI CIP-0103 extension', () => {
  const loadApi = rpc => {
    jest.resetModules();
    delete window.CardanoAPI;
    jest.spyOn(window, 'postMessage').mockImplementation(() => {});
    require('./cardanoApiInject');
    return new window.CardanoAPI(null, rpc);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('advertises CIP-0103 after the bulk transaction API is available', async () => {
    const api = loadApi(jest.fn());

    await expect(api.getExtensions()).resolves.toEqual([{ cip: 95 }, { cip: 103 }]);
    expect(api.cip103).toEqual({
      signTxs: expect.any(Function),
      submitTxs: expect.any(Function),
    });
  });

  test('initial injector advertises CIP-0103 as a supported extension', () => {
    jest.resetModules();
    delete window.cardano;
    jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    require('./initialInject');

    expect(window.cardano.yoroi.supportedExtensions).toEqual([{ cip: 95 }, { cip: 103 }]);
  });

  test('signTxs returns witness sets in input order', async () => {
    const rpc = jest.fn((func, params) => Promise.resolve(`witness-${params[0].tx}`));
    const api = loadApi(rpc);

    await expect(
      api.cip103.signTxs([
        { cbor: 'tx-0', partialSign: false },
        { cbor: 'tx-1', partialSign: true },
      ])
    ).resolves.toEqual(['witness-tx-0', 'witness-tx-1']);

    expect(rpc.mock.calls).toEqual([
      ['sign_tx/cardano', [{ tx: 'tx-0', partialSign: false, returnTx: false }], 'cbor'],
      ['sign_tx/cardano', [{ tx: 'tx-1', partialSign: true, returnTx: false }], 'cbor'],
    ]);
  });

  test('signTxs rejects with the failing transaction index', async () => {
    const signError = { code: 1, info: 'invalid tx' };
    const rpc = jest.fn((func, params) => {
      if (params[0].tx === 'tx-1') {
        return Promise.reject(signError);
      }
      return Promise.resolve(`witness-${params[0].tx}`);
    });
    const api = loadApi(rpc);

    await expect(
      api.cip103.signTxs([
        { cbor: 'tx-0', partialSign: false },
        { cbor: 'tx-1', partialSign: false },
        { cbor: 'tx-2', partialSign: false },
      ])
    ).rejects.toEqual({ index: 1, error: signError });

    expect(rpc.mock.calls).toEqual([
      ['sign_tx/cardano', [{ tx: 'tx-0', partialSign: false, returnTx: false }], 'cbor'],
      ['sign_tx/cardano', [{ tx: 'tx-1', partialSign: false, returnTx: false }], 'cbor'],
    ]);
  });

  test('submitTxs returns transaction hashes in input order when all submissions pass', async () => {
    const rpc = jest.fn((func, params) => Promise.resolve(`hash-${params[0]}`));
    const api = loadApi(rpc);

    await expect(api.cip103.submitTxs(['tx-0', 'tx-1'])).resolves.toEqual(['hash-tx-0', 'hash-tx-1']);

    expect(rpc.mock.calls).toEqual([
      ['submit_tx', ['tx-0'], 'cbor'],
      ['submit_tx', ['tx-1'], 'cbor'],
    ]);
  });

  test('submitTxs attempts every transaction and rejects with mixed indexed results', async () => {
    const submitError = { code: 2, info: 'submit failed' };
    const rpc = jest.fn((func, params) => {
      if (params[0] === 'tx-1') {
        return Promise.reject(submitError);
      }
      return Promise.resolve(`hash-${params[0]}`);
    });
    const api = loadApi(rpc);

    await expect(api.cip103.submitTxs(['tx-0', 'tx-1', 'tx-2'])).rejects.toEqual(['hash-tx-0', submitError, 'hash-tx-2']);

    expect(rpc.mock.calls).toEqual([
      ['submit_tx', ['tx-0'], 'cbor'],
      ['submit_tx', ['tx-1'], 'cbor'],
      ['submit_tx', ['tx-2'], 'cbor'],
    ]);
  });
});
