import jsonServerPkg from 'json-server';
const { create, bodyParser, defaults } = jsonServerPkg;

export const mockedServerPorts = 21000;
export const mockDAppUrl = `http://localhost:${mockedServerPorts}/mock-dapp`;
export const emptyAddressRoutes = Object.freeze(['/v1/addresses/filter-used', '/v1/addresses/utxos', '/v1/addresses/txs']);
export const emptyAccountResources = Object.freeze(['utxos', 'txs', 'rewards']);

const isPaymentAddress = value => typeof value === 'string' && /^addr(?:_test)?1[02-9ac-hj-np-z]+$/.test(value);
const isStakeAddress = value => typeof value === 'string' && /^stake(?:_test)?1[02-9ac-hj-np-z]+$/.test(value);

export const emptyAddressRequest = body => {
  const addresses = body?.addresses;
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 1000 || !addresses.every(isPaymentAddress)) {
    return { status: 400, body: { error: 'invalid fixture request' } };
  }
  return { status: 200, body: [] };
};

export const emptyAccountRequest = stakeAddress => {
  if (!isStakeAddress(stakeAddress)) {
    return { status: 400, body: { error: 'invalid fixture request' } };
  }
  return { status: 200, body: [] };
};

export const emptyAccountState = stakeAddress => ({
  stakeAddress,
  registered: false,
  balance: '0',
  rewardsAvailable: '0',
  rewardsSum: '0',
  withdrawalsSum: '0',
  delegatedPool: null,
  delegatedDrep: null,
});

const sendFixtureResponse = (res, response) => res.status(response.status).json(response.body);

export const getMockServer = settings => {
  const middlewares = [...defaults({ logger: !!settings.outputLog }), bodyParser];

  const server = create();
  console.log(`JSON Server Created`);

  server.use(middlewares);

  server.get('/mock-dapp', (req, res) => {
    res.header('content-type', 'text/html');
    res.send(`
             <!doctype html>
             <html lang="en">
               <head>
                 <title>MockDApp</title>
               </head>
               <body>
               </body>
             </html>
             `);
  });

  server.get('/v1/account/:stakeAddress/state', (req, res) => {
    res.json(emptyAccountState(req.params.stakeAddress));
  });

  for (const route of emptyAddressRoutes) {
    server.post(route, (req, res) => sendFixtureResponse(res, emptyAddressRequest(req.body)));
  }
  for (const resource of emptyAccountResources) {
    server.get(`/v1/account/:stakeAddress/${resource}`, (req, res) =>
      sendFixtureResponse(res, emptyAccountRequest(req.params.stakeAddress))
    );
  }

  server.get('/v1/status', (_req, res) => {
    res.json({
      version: 'e2e',
      network: 'mainnet',
      provider: 'fixture',
      chain: 'ok',
      behindSeconds: 0,
      tip: { blockTime: 1700000000 },
    });
  });

  server.get('/v1/chain/tip', (_req, res) => {
    res.json({
      block: 1,
      epoch: 1,
      slot: 1,
      hash: '00'.repeat(32),
      blockTime: 1700000000,
    });
  });

  server.post('/v1/tx/submit', (_req, res) => {
    res.json({ txHash: '00'.repeat(32) });
  });

  return new Promise((resolve, reject) => {
    const mockServer = server.listen(mockedServerPorts, () => {
      console.log(`JSON Server is running at http://localhost:${mockedServerPorts}`);
      resolve(mockServer);
    });

    mockServer.on('error', err => {
      reject(err);
    });
  });
};
