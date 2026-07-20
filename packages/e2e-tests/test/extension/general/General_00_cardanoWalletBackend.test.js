import { expect } from 'chai';
import driversPoolsManager from '../../../utils/driversPool.js';

const backendUrl = process.env.CARDANO_WALLET_BACKEND_URL;
const expectedNetwork = process.env.CARDANO_NETWORK || 'preprod';

describe('Cardano wallet backend integration _smoke_', function () {
  this.timeout(60_000);

  let webdriver;

  before(async function () {
    if (!backendUrl) {
      this.skip();
    }
    webdriver = await driversPoolsManager.getDriverFromPool();
  });

  after(async function () {
    if (webdriver) {
      await webdriver.quit();
    }
  });

  for (const endpoint of ['/v1/status', '/v1/chain/tip']) {
    it(`loads ${endpoint} from the built extension`, async function () {
      const response = await webdriver.executeAsyncScript(async (url, done) => {
        try {
          const result = await fetch(url);
          done({
            body: await result.json(),
            ok: result.ok,
            status: result.status,
          });
        } catch (error) {
          done({ error: String(error) });
        }
      }, `${backendUrl}${endpoint}`);

      expect(response.error, response.error).to.equal(undefined);
      expect(response.status).to.equal(200);
      expect(response.ok).to.equal(true);
      if (endpoint === '/v1/status') {
        expect(response.body.network).to.equal(expectedNetwork);
        expect(response.body.chain).to.equal('ok');
        expect(response.body.tip.block).to.be.a('number').and.greaterThan(0);
      } else {
        expect(response.body.block).to.be.a('number').and.greaterThan(0);
        expect(response.body.epoch).to.be.a('number').and.greaterThan(0);
      }
    });
  }
});
