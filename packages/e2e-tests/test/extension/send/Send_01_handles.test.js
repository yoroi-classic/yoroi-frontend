import { expect } from 'chai';
import driversPoolsManager from '../../../utils/driversPool.js';
import TransactionsSubTab from '../../../pages/wallet/walletTab/walletTransactions.page.js';
import { customAfterEach } from '../../../utils/customHooks.js';
import { getTestLogger } from '../../../utils/utils.js';
import { oneMinute } from '../../../helpers/timeConstants.js';
import { prepareWallet } from '../../../helpers/restoreWalletHelper.js';
import SendSubTab from '../../../pages/wallet/walletTab/sendSubTab.page.js';
import TxReviewOverviewTab from '../../../pages/transactionReviewPages/txReviewOverviewTab.page.js';
import { getTestString } from '../../../helpers/constants.js';
import { RECEIVER_DOESNT_EXIST } from '../../../helpers/messages.js';
import { WebDriver } from 'selenium-webdriver';
import { Logger } from 'simple-node-logger';

describe('Handle handles', function () {
  this.timeout(2 * oneMinute);
  /** @type {WebDriver} */
  let webdriver = null;
  /** @type {Logger} */
  let logger = null;
  /** @type {TransactionsSubTab} */
  let transactionsPage = null;
  /** @type {SendSubTab} */
  let sendSubTab = null;
  /** @type {TxReviewOverviewTab} */
  let txReviewOverview = null;

  before(async function () {
    webdriver = await driversPoolsManager.getDriverFromPool();
    logger = getTestLogger(this.test.parent.title);
    await prepareWallet(webdriver, logger, 'testWallet1Mainnet', this, false);
    transactionsPage = new TransactionsSubTab(webdriver, logger);
    sendSubTab = new SendSubTab(webdriver, logger);
    txReviewOverview = new TxReviewOverviewTab(webdriver, logger);
  });

  const testDataPositive = [
    {
      userHandle: '$svinkopepo',
      provider: 'ADA Handle',
      expectedAddress: 'addr1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgtpv9skzctpv9skzctpv9skzctpv9skzctpv9skzctpv9sj5qe6w',
    },
    {
      userHandle: 'rahul.ada',
      provider: 'Cardano Name Service (CNS)',
      expectedAddress: 'addr1qypqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqmh5agv',
    },
    {
      userHandle: 'stackchain.blockchain',
      provider: 'Unstoppable Domains',
      expectedAddress: 'addr1qypsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xsjld0cj',
    },
  ];

  const testDataNegative = [
    {
      userHandle: `${getTestString('$', 10, false)}`,
      provider: 'ADA Handle',
    },
    {
      userHandle: `${getTestString('', 7, false)}.ada`,
      provider: 'Cardano Name Service (CNS)',
    },
    {
      userHandle: `${getTestString('', 10, false)}.blockchain`,
      provider: 'Unstoppable Domains',
    },
  ];

  for (const testDatum of testDataPositive) {
    describe(`Positive case, ${testDatum.provider}`, function () {
      it(`Refresh page, ${testDatum.provider}`, async function () {
        await transactionsPage.refreshPage();
      });

      it(`Go to Send page, ${testDatum.provider}`, async function () {
        await transactionsPage.goToSendSubMenu();
        const stepOneDisplayed = await sendSubTab.stepOneIsDisplayed();
        expect(stepOneDisplayed, 'Step one is not displayed').to.be.true;
      });

      it(`Enter the value, ${testDatum.provider}`, async function () {
        await sendSubTab.enterReceiver(testDatum.userHandle);
      });

      it(`Wait for domain resolver response, ${testDatum.provider}`, async function () {
        const greenMarkIsDisplayed = await sendSubTab.receiverIsGood();
        expect(greenMarkIsDisplayed, 'Receiver is not checked').to.be.true;
      });

      it(`Check displayed info and continue, ${testDatum.provider}`, async function () {
        const helperText = await sendSubTab.getReceiverHelperText();
        expect(helperText, 'A different provider is displayed').to.equal(testDatum.provider);
        const handlerAddress = await sendSubTab.getReceiverHandlerAddress();
        const expectedTruncatedAddress = `${testDatum.expectedAddress.slice(0, 10)}...${testDatum.expectedAddress.slice(-10)}`;
        expect(handlerAddress, 'Resolver returned a different recipient').to.contain(expectedTruncatedAddress);
        await sendSubTab.takeScreenshot(this.test.parent.parent.title, `Check displayed info and continue_${testDatum.provider}`);
        await sendSubTab.clickNextToStep2();
      });

      it(`Enter amount and continue, ${testDatum.provider}`, async function () {
        await sendSubTab.addAssets('1');
      });

      it(`Check info on confirmation page, ${testDatum.provider}`, async function () {
        const userHandle = await txReviewOverview.getReceiver();
        expect(userHandle, 'User handler is different').to.equal(testDatum.userHandle);
      });
    });
  }

  for (const testNegativeDatum of testDataNegative) {
    describe(`Negative case, ${testNegativeDatum.provider}`, function () {
      it(`Refresh page, ${testNegativeDatum.provider}`, async function () {
        await transactionsPage.refreshPage();
      });

      it(`Go to Send page, ${testNegativeDatum.provider}`, async function () {
        await transactionsPage.goToSendSubMenu();
        const stepOneDisplayed = await sendSubTab.stepOneIsDisplayed();
        expect(stepOneDisplayed, 'Step one is not displayed').to.be.true;
      });

      it(`Enter the value, ${testNegativeDatum.provider}`, async function () {
        await sendSubTab.enterReceiver(testNegativeDatum.userHandle);
      });

      it(`Wait and check displayed info, ${testNegativeDatum.provider}`, async function () {
        const errorMessageIsDisplayed = await sendSubTab.waitReceiverHelperTextEqual(RECEIVER_DOESNT_EXIST);
        expect(errorMessageIsDisplayed, 'A different error message is displayed').to.equal(true);
      });
    });
  }

  afterEach(async function () {
    await customAfterEach(this, webdriver, logger);
  });

  after(async function () {
    await transactionsPage.closeBrowser();
  });
});
