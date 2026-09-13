import { customAfterEach, customBeforeNestedDAppTest } from '../../utils/customHooks.js';
import { expect } from 'chai';
import { getTestLogger } from '../../utils/utils.js';
import { oneMinute } from '../../helpers/timeConstants.js';
import { collectInfo, preloadDBAndStorage, waitTxPage } from '../../helpers/restoreWalletHelper.js';
import { WindowManager, mockDAppName } from '../../helpers/windowManager.js';
import { closeMockServer, getMockServer, mockDAppUrl } from '../../helpers/mock-dApp-webpage/mockServer.js';
import { MockDAppWebpage } from '../../helpers/mock-dApp-webpage/mockedDApp.js';
import { connectNonAuth } from '../../helpers/mock-dApp-webpage/dAppHelper.js';
import { adaInLovelaces } from '../../helpers/constants.js';
import driversPoolsManager from '../../utils/driversPool.js';
import { WebDriver } from 'selenium-webdriver';
import { Logger } from 'simple-node-logger';
import { testWallet1 } from '../../utils/testWallets.js';
import WalletCommonBase from '../../pages/walletCommonBase.page.js';

const maxCollateralInputs = 3;
const lovelacesPerAda = BigInt(adaInLovelaces);

const expectCollateralCovers = (collateralResponse, requestedAmount) => {
  expect(collateralResponse.success, 'The request getCollateral failed').to.be.true;
  expect(collateralResponse.retValue).to.be.an('array').that.is.not.empty;
  expect(collateralResponse.retValue.length, 'There are more collateral inputs than allowed').to.be.at.most(maxCollateralInputs);
  const receivedAmount = collateralResponse.retValue.reduce((accumulator, utxo) => accumulator + BigInt(utxo.amount), 0n);
  expect(receivedAmount >= requestedAmount, 'The returned collateral does not cover the requested amount').to.be.true;
};

describe('dApp, getCollateral, no popup, positive', function () {
  this.timeout(2 * oneMinute);
  /** @type {WebDriver} */
  let webdriver = null;
  /** @type {Logger} */
  let logger = null;
  /** @type {WindowManager} */
  let windowManager = null;
  let mockServer = null;
  /** @type {MockDAppWebpage} */
  let mockedDApp = null;
  /** @type {WalletCommonBase} */
  let walletCommonPage = null;

  before(async function () {
    try {
      mockServer = await getMockServer({});
      logger = getTestLogger(this.test.parent.title);
      webdriver = await driversPoolsManager.getPreparedDriver();
      const wmLogger = getTestLogger('windowManager', this.test.parent.title);
      windowManager = new WindowManager(webdriver, wmLogger);
      await windowManager.init();
      const dappLogger = getTestLogger('dApp', this.test.parent.title);
      mockedDApp = new MockDAppWebpage(webdriver, dappLogger);
      walletCommonPage = new WalletCommonBase(webdriver, logger);
      await preloadDBAndStorage(webdriver, logger, 'testWallet1');
      await waitTxPage(webdriver, logger);
    } catch (error) {
      await collectInfo(this, webdriver, logger);
      throw new Error(error);
    }
  });

  it('Open a dapp page', async function () {
    await windowManager.openNewTab(mockDAppName, mockDAppUrl);
  });

  it('Connect the wallet without auth to the dapp', async function () {
    await connectNonAuth(webdriver, logger, windowManager, mockedDApp, testWallet1);
  });

  describe('[nested-dapp] Collateral, 1 ADA', function () {
    before(async function () {
      await customBeforeNestedDAppTest(this, windowManager);
    });

    it('Getting collateral for 1 ADA', async function () {
      const requestedAmount = lovelacesPerAda;
      const collateralResponse = await mockedDApp.getCollateral(requestedAmount.toString());
      expectCollateralCovers(collateralResponse, requestedAmount);
    });
  });

  describe('[nested-dapp] Collateral, 3 ADA', function () {
    before(async function () {
      await customBeforeNestedDAppTest(this, windowManager);
    });

    it('Getting collateral for 3 ADA', async function () {
      const requestedAmount = 3n * lovelacesPerAda;
      const collateralResponse = await mockedDApp.getCollateral(requestedAmount.toString());
      expectCollateralCovers(collateralResponse, requestedAmount);
    });
  });

  describe('[nested-dapp] Collateral, 5 ADA', function () {
    before(async function () {
      await customBeforeNestedDAppTest(this, windowManager);
    });

    it('Getting collateral for 5 ADA', async function () {
      const requestedAmount = 5n * lovelacesPerAda;
      const collateralResponse = await mockedDApp.getCollateral(requestedAmount.toString());
      expectCollateralCovers(collateralResponse, requestedAmount);
    });
  });

  describe('[nested-dapp] Collateral, amount is undefined', function () {
    before(async function () {
      await customBeforeNestedDAppTest(this, windowManager);
    });

    it('Getting collateral for undefined amount', async function () {
      const defaultRequestedAmount = 5n * lovelacesPerAda;
      const collateralResponse = await mockedDApp.getCollateral();
      expectCollateralCovers(collateralResponse, defaultRequestedAmount);
    });
  });

  afterEach(async function () {
    await customAfterEach(this, webdriver, logger);
  });

  after(async function () {
    await walletCommonPage.closeBrowser();
    await closeMockServer(mockServer);
  });
});
