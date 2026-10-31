import assert from 'node:assert/strict';
import test from 'node:test';
import TrezorConnect from '../pages/trezorConnect.page.js';

test('waits for the v10 export prompt and activates WebUSB with a user click', async () => {
  const page = new TrezorConnect({}, { info() {} });
  const connectButton = {};
  const findButton = {};
  let connectPromptVisible = false;
  const clicks = [];

  page.findElements = async locator => {
    if (locator === page.connectTrezorButtonLocator) return connectPromptVisible ? [connectButton] : [];
    if (locator === page.legacyExportTrezorButtonLocator) return [];
    return locator === page.findTrezorButtonLocator ? [findButton] : [];
  };
  page.customWaiter = async condition => {
    assert.equal(await condition(), false);
    connectPromptVisible = true;
    return condition();
  };
  page.click = async locator => clicks.push(locator);
  page.clickByScript = async () => {
    throw new Error('WebUSB must not be activated by a script click');
  };
  page.waitForElement = async locator => assert.equal(locator, page.findTrezorButtonLocator);

  await page.allowPubKeysExport();

  assert.deepEqual(clicks, [page.connectTrezorButtonLocator, page.findTrezorButtonLocator]);
});
