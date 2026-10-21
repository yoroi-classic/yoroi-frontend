import { expect } from 'chai';
import DAppConnectWallet from '../../pages/dapp/dAppConnectWallet.page.js';
import { mockDAppName, popupConnectorName } from '../windowManager.js';
import {
  bytesToHex,
  getAddressFromBytes,
  getAddressFromBech32,
  getLargestFirstMultiAsset,
  getTransactionOutput,
  getTxBuilder,
  getCmlUtxos,
} from './dAppTxHelper.js';
import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs';

/**
 * The function to request non-authorised connection the a wallet.
 * Also several checks are in here.
 * @param {ThenableWebDriver} webdriver
 * @param {Logger} logger
 * @param {WindowManager} windowManager
 * @param {MockDAppWebpage} mockedDApp
 * @param {{name: string, plate: string, mnemonic: string}} testWalettObj
 * @param {boolean} checkBalance
 * @returns {Promise<{walletBalance: number, walletName: string, walletPlate: string}>}
 */
export const connectNonAuth = async (webdriver, logger, windowManager, mockedDApp, testWalettObj, checkBalance = true) => {
  await mockedDApp.requestAccess();
  const dappConnectPage = new DAppConnectWallet(webdriver, logger);
  // the window focus is switched to the pop-up here
  const popUpAppeared = await dappConnectPage.popUpIsDisplayed(windowManager);
  expect(popUpAppeared, 'The connector pop-up is not displayed').to.be.true;
  await dappConnectPage.waitingConnectorIsReady();
  const allWallets = await dappConnectPage.getWallets();
  expect(allWallets.length).to.equal(1);
  const walletInfo = await dappConnectPage.getWalletInfo(testWalettObj.plate);
  if (checkBalance) {
    expect(walletInfo.walletBalance, 'The wallet balance is different').to.equal(testWalettObj.balance);
  }
  expect(walletInfo.walletName, `The wallet name should be "${testWalettObj.name}"`).to.equal(testWalettObj.name);
  expect(walletInfo.walletPlate, `The wallet plate should be "${testWalettObj.plate}"`).to.equal(testWalettObj.plate);
  await dappConnectPage.selectWallet(testWalettObj.plate);
  const result = await windowManager.isClosed(popupConnectorName);
  expect(result, 'The window|tab is still opened').to.be.true;
  await windowManager.switchTo(mockDAppName);
  const requestAccessResult = await mockedDApp.checkAccessRequest();
  expect(requestAccessResult.success, `Request access failed: ${requestAccessResult.errMsg}`).to.be.true;
  return walletInfo;
};

/**
 * Creates a simple unsigned Tx
 * @param {string} receiverAddrBech32 - receiver address in Bech32 format
 * @param {string} amount - amount to send in lovelaces. Example: "2000000" (2 ADA)
 * @param {string} changeAddressHex - change address in HEX format
 * @param {Array<string>} utxosHex - UTxOs available in the wallet
 * @returns {{uTxHex: string, txFee: string}} Unsigned Tx in HEX format
 */
export const buildSimpleTx = (receiverAddrBech32, amount, changeAddressHex, utxosHex) => {
  const buildTransactionInput = { amount, address: receiverAddrBech32 };
  const txBuilder = getTxBuilder();
  const cmlChangeAddress = getAddressFromBytes(changeAddressHex);
  const cmlOutputAddress = getAddressFromBech32(receiverAddrBech32);
  const cmlOutput = getTransactionOutput(cmlOutputAddress, buildTransactionInput);
  txBuilder.add_output(cmlOutput);
  const cmlUtxos = getCmlUtxos(utxosHex);
  for (const utxo of cmlUtxos) {
    txBuilder.add_utxo(CML.SingleInputBuilder.from_transaction_unspent_output(utxo).payment_key());
  }
  txBuilder.select_utxos(getLargestFirstMultiAsset());
  const signedBuilder = txBuilder.build(CML.ChangeSelectionAlgo.Default, cmlChangeAddress);
  const unsignedTransaction = signedBuilder.build_unchecked();
  const txFee = unsignedTransaction.body().fee().toString();
  const unsignedTxHex = bytesToHex(unsignedTransaction.to_cbor_bytes());

  return {
    uTxHex: unsignedTxHex,
    txFee,
  };
};
