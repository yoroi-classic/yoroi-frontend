describe('CardanoAPI CIP-0103 extension', () => {
  const disconnectListeners = [];

  const loadApi = rpc => {
    jest.resetModules();
    delete window.CardanoAPI;
    jest.spyOn(window, 'postMessage').mockImplementation(() => {});
    const addEventListener = window.addEventListener.bind(window);
    jest.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'yoroi_wallet_disconnected') {
        disconnectListeners.push({ listener, options });
      }
      return addEventListener(type, listener, options);
    });
    require('./cardanoApiInject');
    return new window.CardanoAPI(null, rpc);
  };

  afterEach(() => {
    for (const { listener, options } of disconnectListeners.splice(0)) {
      window.removeEventListener('yoroi_wallet_disconnected', listener, options);
    }
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

  test('does not advertise CIP-0103 when the bulk transaction API is incomplete', async () => {
    const api = loadApi(jest.fn());

    api.cip103 = Object.freeze({ signTxs: api.cip103.signTxs });

    await expect(api.getExtensions()).resolves.toEqual([{ cip: 95 }]);
  });

  test('initial injector advertises CIP-0103 as a supported extension', () => {
    jest.resetModules();
    delete window.cardano;
    jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    require('./initialInject');

    expect(window.cardano.yoroi.supportedExtensions).toEqual([{ cip: 95 }, { cip: 103 }]);
  });

  test('signTxs returns witness sets in input order', async () => {
    const rpc = jest.fn((func, params) => Promise.resolve(params[0].map(({ tx }) => `witness-${tx}`)));
    const api = loadApi(rpc);

    await expect(
      api.cip103.signTxs([
        { cbor: 'tx-0', partialSign: false },
        { cbor: 'tx-1', partialSign: true },
      ])
    ).resolves.toEqual(['witness-tx-0', 'witness-tx-1']);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'sign_txs/cardano',
      [
        [
          { tx: 'tx-0', partialSign: false, returnTx: false },
          { tx: 'tx-1', partialSign: true, returnTx: false },
        ],
      ],
      'cbor'
    );
  });

  test('signTxs normalizes CIP-0103 requests into one witness-only batch RPC call', async () => {
    const rpc = jest.fn((func, params) => Promise.resolve(params[0].map(({ tx }) => `witness-${tx}`)));
    const api = loadApi(rpc);

    await expect(
      api.cip103.signTxs([{ cbor: 'tx-0' }, { cbor: 'tx-1', partialSign: true, tx: 'legacy-tx-field', returnTx: true }])
    ).resolves.toEqual(['witness-tx-0', 'witness-tx-1']);

    expect(rpc).toHaveBeenCalledWith(
      'sign_txs/cardano',
      [
        [
          { tx: 'tx-0', partialSign: false, returnTx: false },
          { tx: 'tx-1', partialSign: true, returnTx: false },
        ],
      ],
      'cbor'
    );
  });

  test('CIP-0103 calls keep CBOR return type after the experimental return type changes', async () => {
    const rpc = jest.fn((func, params) => {
      if (func === 'submit_tx') return Promise.resolve(`hash-${params[0]}`);
      if (func === 'sign_txs/cardano') return Promise.resolve(params[0].map(({ tx }) => `witness-${tx}`));
      return Promise.resolve(`witness-${params[0].tx}`);
    });
    const api = loadApi(rpc);

    api.experimental.setReturnType('json');

    await expect(api.signTx('legacy-tx')).resolves.toEqual('witness-legacy-tx');
    await expect(api.cip103.signTxs([{ cbor: 'tx-0' }])).resolves.toEqual(['witness-tx-0']);
    await expect(api.cip103.submitTxs(['tx-1'])).resolves.toEqual(['hash-tx-1']);

    expect(rpc.mock.calls).toEqual([
      ['sign_tx/cardano', [{ tx: 'legacy-tx', partialSign: false, returnTx: false }], 'json'],
      ['sign_txs/cardano', [[{ tx: 'tx-0', partialSign: false, returnTx: false }]], 'cbor'],
      ['submit_tx', ['tx-1'], 'cbor'],
    ]);
  });

  test('signTxs snapshots the batch before signing', async () => {
    let resolveSignatures;
    const rpc = jest.fn(
      () =>
        new Promise(resolve => {
          resolveSignatures = resolve;
        })
    );
    const api = loadApi(rpc);
    const txs = [
      { cbor: 'tx-0', partialSign: false },
      { cbor: 'tx-1', partialSign: false },
    ];

    const signing = api.cip103.signTxs(txs);
    txs.push({ cbor: 'tx-2', partialSign: false });
    resolveSignatures(['witness-tx-0', 'witness-tx-1']);

    await expect(signing).resolves.toEqual(['witness-tx-0', 'witness-tx-1']);
    expect(rpc).toHaveBeenCalledWith(
      'sign_txs/cardano',
      [
        [
          { tx: 'tx-0', partialSign: false, returnTx: false },
          { tx: 'tx-1', partialSign: false, returnTx: false },
        ],
      ],
      'cbor'
    );
  });

  test('signTxs snapshots transaction request fields before signing', async () => {
    let resolveSignatures;
    const rpc = jest.fn(
      () =>
        new Promise(resolve => {
          resolveSignatures = resolve;
        })
    );
    const api = loadApi(rpc);
    const txs = [
      { cbor: 'tx-0', partialSign: false },
      { cbor: 'tx-1', partialSign: false },
    ];

    const signing = api.cip103.signTxs(txs);
    txs[1].cbor = 'tx-mutated';
    txs[1].partialSign = true;
    resolveSignatures(['witness-tx-0', 'witness-tx-1']);

    await expect(signing).resolves.toEqual(['witness-tx-0', 'witness-tx-1']);
    expect(rpc).toHaveBeenCalledWith(
      'sign_txs/cardano',
      [
        [
          { tx: 'tx-0', partialSign: false, returnTx: false },
          { tx: 'tx-1', partialSign: false, returnTx: false },
        ],
      ],
      'cbor'
    );
  });

  test('signTxs preserves the transaction index when request snapshotting fails', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);
    const brokenRequest = {
      get cbor() {
        throw new Error('getter failed');
      },
    };

    await expect(api.cip103.signTxs([{ cbor: 'tx-0' }, brokenRequest])).rejects.toEqual({
      code: -1,
      index: 1,
      info: 'getter failed (transaction index 1)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTxs normalizes a batch element snapshot failure as indexed InvalidRequest', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);
    const txs = [{ cbor: 'tx-0' }, { cbor: 'tx-1' }];
    Object.defineProperty(txs, 1, {
      get() {
        throw new Error('batch getter failed');
      },
    });

    await expect(api.cip103.signTxs(txs)).rejects.toEqual({
      code: -1,
      index: 1,
      info: 'batch getter failed (transaction index 1)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTxs normalizes hostile thrown error accessors as indexed InvalidRequest', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);
    const hostileError = {};
    Object.defineProperties(hostileError, {
      code: {
        get() {
          throw new Error('code getter failed');
        },
      },
      info: {
        get() {
          throw new Error('info getter failed');
        },
      },
      message: {
        get() {
          throw new Error('message getter failed');
        },
      },
    });
    const brokenRequest = {
      get cbor() {
        throw hostileError;
      },
    };

    await expect(api.cip103.signTxs([{ cbor: 'tx-0' }, brokenRequest])).rejects.toEqual({
      code: -1,
      index: 1,
      info: 'Invalid CIP-0103 transaction request (transaction index 1)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTxs rejects with the failing transaction index', async () => {
    const signError = { code: 1, info: 'invalid tx' };
    const rpc = jest.fn(() =>
      // Connector RPC errors are API error records rather than JavaScript Error instances.
      // eslint-disable-next-line prefer-promise-reject-errors
      Promise.reject({
        ...signError,
        index: 1,
        info: 'invalid tx (transaction index 1)',
      })
    );
    const api = loadApi(rpc);

    await expect(
      api.cip103.signTxs([
        { cbor: 'tx-0', partialSign: false },
        { cbor: 'tx-1', partialSign: false },
        { cbor: 'tx-2', partialSign: false },
      ])
    ).rejects.toEqual({ code: 1, info: 'invalid tx (transaction index 1)', index: 1 });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'sign_txs/cardano',
      [
        [
          { tx: 'tx-0', partialSign: false, returnTx: false },
          { tx: 'tx-1', partialSign: false, returnTx: false },
          { tx: 'tx-2', partialSign: false, returnTx: false },
        ],
      ],
      'cbor'
    );
  });

  test('signTxs preserves an indexless batch rejection', async () => {
    const rejection = { code: 2, info: 'User rejected' };
    const rpc = jest.fn(() => {
      // Connector RPC errors are API error records rather than JavaScript Error instances.
      // eslint-disable-next-line prefer-promise-reject-errors
      return Promise.reject(rejection);
    });
    const api = loadApi(rpc);

    await expect(api.cip103.signTxs([{ cbor: 'tx-0' }, { cbor: 'tx-1' }])).rejects.toBe(rejection);
    expect(rejection).toEqual({ code: 2, info: 'User rejected' });
  });

  test('signTxs returns an empty result without opening an approval flow', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);

    await expect(api.cip103.signTxs([])).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTxs preserves request validation messages with the failing transaction index', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);

    await expect(api.cip103.signTxs([{ cbor: 'tx-0' }, { partialSign: false }])).rejects.toEqual({
      code: -1,
      index: 1,
      info: '.cip103.signTxs transaction request requires a cbor string! (transaction index 1)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTxs rejects a non-boolean partialSign before prompting for any transaction', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);

    await expect(api.cip103.signTxs([{ cbor: 'tx-0' }, { cbor: 'tx-1', partialSign: 'true' }])).rejects.toEqual({
      code: -1,
      index: 1,
      info: '.cip103.signTxs transaction request partialSign must be a boolean! (transaction index 1)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['positional', api => api.signTx('tx-0', 'false')],
    ['object', api => api.signTx({ tx: 'tx-0', partialSign: 'false' })],
    ['object null', api => api.signTx({ tx: 'tx-0', partialSign: null })],
  ])('signTx rejects a non-boolean %s partialSign before prompting', (_description, sign) => {
    const rpc = jest.fn();
    const api = loadApi(rpc);

    expect(() => sign(api)).toThrow('.signTx partialSign must be a boolean!');
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTx defaults an omitted object partialSign to false', async () => {
    const rpc = jest.fn().mockResolvedValue('witness-tx-0');
    const api = loadApi(rpc);

    await expect(api.signTx({ tx: 'tx-0' })).resolves.toEqual('witness-tx-0');
    expect(rpc).toHaveBeenCalledWith('sign_tx/cardano', [{ tx: 'tx-0', partialSign: false, returnTx: undefined }], 'cbor');
  });

  test('signTxs rejects non-spec tx requests', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);

    await expect(api.cip103.signTxs([{ tx: 'tx-0' }])).rejects.toEqual({
      code: -1,
      index: 0,
      info: '.cip103.signTxs transaction request requires a cbor string! (transaction index 0)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTxs does not impose a non-standard batch-size limit', async () => {
    const rpc = jest.fn((func, params) => Promise.resolve(params[0].map(({ tx }) => `witness-${tx}`)));
    const api = loadApi(rpc);
    const txs = Array.from({ length: 21 }, (_, index) => ({ cbor: `tx-${index}` }));

    await expect(api.cip103.signTxs(txs)).resolves.toEqual(txs.map(({ cbor }) => `witness-${cbor}`));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test('signTxs rejects a non-array batch as InvalidRequest without prompting', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);

    await expect(api.cip103.signTxs('tx-0')).rejects.toEqual({
      code: -1,
      info: '.cip103.signTxs argument is expected to be an array!',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTxs normalizes a batch length failure as InvalidRequest', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);
    const txs = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('length getter failed');
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(api.cip103.signTxs(txs)).rejects.toEqual({
      code: -1,
      info: 'length getter failed',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('signTxs normalizes a bare-string batch failure as indexed InvalidRequest', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);
    const txs = [];
    Object.defineProperty(txs, 0, {
      get() {
        throw 'bare string failure';
      },
    });
    Object.defineProperty(txs, 'length', { value: 1 });

    await expect(api.cip103.signTxs(txs)).rejects.toEqual({
      code: -1,
      index: 0,
      info: 'bare string failure (transaction index 0)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('submitTxs returns transaction hashes in input order when all submissions pass', async () => {
    let activeSubmissions = 0;
    let maxActiveSubmissions = 0;
    const rpc = jest.fn(async (func, params) => {
      activeSubmissions++;
      maxActiveSubmissions = Math.max(maxActiveSubmissions, activeSubmissions);
      await Promise.resolve();
      activeSubmissions--;
      return `hash-${params[0]}`;
    });
    const api = loadApi(rpc);

    await expect(api.cip103.submitTxs(['tx-0', 'tx-1'])).resolves.toEqual(['hash-tx-0', 'hash-tx-1']);
    expect(maxActiveSubmissions).toEqual(1);

    expect(rpc.mock.calls).toEqual([
      ['submit_tx', ['tx-0'], 'cbor'],
      ['submit_tx', ['tx-1'], 'cbor'],
    ]);
  });

  test('submitTxs snapshots the batch before submitting', async () => {
    let resolveFirstSubmission;
    const rpc = jest.fn((func, params) => {
      if (params[0] === 'tx-0') {
        return new Promise(resolve => {
          resolveFirstSubmission = resolve;
        });
      }
      return Promise.resolve(`hash-${params[0]}`);
    });
    const api = loadApi(rpc);
    const txs = ['tx-0', 'tx-1'];

    const submitting = api.cip103.submitTxs(txs);
    txs.push('tx-2');
    resolveFirstSubmission('hash-tx-0');

    await expect(submitting).resolves.toEqual(['hash-tx-0', 'hash-tx-1']);
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

  test('submitTxs does not impose a non-standard batch-size limit', async () => {
    const rpc = jest.fn((func, params) => Promise.resolve(`hash-${params[0]}`));
    const api = loadApi(rpc);
    const txs = Array.from({ length: 21 }, (_, index) => `tx-${index}`);

    await expect(api.cip103.submitTxs(txs)).resolves.toEqual(txs.map(tx => `hash-${tx}`));
    expect(rpc).toHaveBeenCalledTimes(txs.length);
  });

  test('submitTxs preflights the whole batch as InvalidRequest', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);

    await expect(api.cip103.submitTxs(['tx-0', null])).rejects.toEqual({
      code: -1,
      index: 1,
      info: '.cip103.submitTxs transaction must be a cbor string! (transaction index 1)',
    });
    await expect(api.cip103.submitTxs(null)).rejects.toEqual({
      code: -1,
      info: '.cip103.submitTxs argument is expected to be an array!',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('submitTxs normalizes a batch element snapshot failure as indexed InvalidRequest', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);
    const txs = ['tx-0', 'tx-1'];
    Object.defineProperty(txs, 1, {
      get() {
        throw new Error('batch getter failed');
      },
    });

    await expect(api.cip103.submitTxs(txs)).rejects.toEqual({
      code: -1,
      index: 1,
      info: 'batch getter failed (transaction index 1)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('submitTxs normalizes hostile thrown error accessors as indexed InvalidRequest', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);
    const hostileError = {};
    Object.defineProperties(hostileError, {
      code: {
        get() {
          throw new Error('code getter failed');
        },
      },
      info: {
        get() {
          throw new Error('info getter failed');
        },
      },
      message: {
        get() {
          throw new Error('message getter failed');
        },
      },
    });
    const txs = ['tx-0', 'tx-1'];
    Object.defineProperty(txs, 1, {
      get() {
        throw hostileError;
      },
    });

    await expect(api.cip103.submitTxs(txs)).rejects.toEqual({
      code: -1,
      index: 1,
      info: 'Invalid CIP-0103 transaction request (transaction index 1)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('preflights sparse signing and submission batches before any RPC', async () => {
    const rpc = jest.fn();
    const api = loadApi(rpc);
    const sparseSignBatch = Array(2);
    sparseSignBatch[0] = { cbor: 'tx-0' };
    const sparseSubmitBatch = Array(2);
    sparseSubmitBatch[0] = 'tx-0';

    await expect(api.cip103.signTxs(sparseSignBatch)).rejects.toEqual({
      code: -1,
      index: 1,
      info: '.cip103.signTxs transaction request is expected to be an object! (transaction index 1)',
    });
    await expect(api.cip103.submitTxs(sparseSubmitBatch)).rejects.toEqual({
      code: -1,
      index: 1,
      info: '.cip103.submitTxs transaction must be a cbor string! (transaction index 1)',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
