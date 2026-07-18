import jsonServerPkg from 'json-server';
const { create, bodyParser, defaults } = jsonServerPkg;

export const mockedServerPorts = 21000;
export const mockDAppUrl = `http://localhost:${mockedServerPorts}/mock-dapp`;

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
    res.json({
      stakeAddress: req.params.stakeAddress,
      registered: false,
      balance: '0',
      rewardsAvailable: '0',
      rewardsSum: '0',
      withdrawalsSum: '0',
      delegatedPool: null,
      delegatedDrep: null,
    });
  });

  server.get('/v1/status', (_req, res) => {
    res.json({
      version: 'e2e',
      network: 'mainnet',
      provider: 'fixture',
      chain: 'synced',
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
