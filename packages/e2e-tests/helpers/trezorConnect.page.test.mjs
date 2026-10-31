import assert from 'node:assert/strict';
import test from 'node:test';
import TrezorConnect from '../pages/trezorConnect.page.js';

test('grants Trezor connection permission with a user click', async () => {
  const page = new TrezorConnect({}, { info() {} });
  const clicks = [];

  page.waitForElement = async locator => assert.equal(locator, page.confirmUsingTrezorButtonLocator);
  page.click = async locator => clicks.push(locator);
  page.clickByScript = async () => {
    throw new Error('Trezor permission must be granted with a user click');
  };

  await page.allowConnection();

  assert.deepEqual(clicks, [page.confirmUsingTrezorButtonLocator]);
});

test('waits for the v10 account export confirmation and confirms with a user click', async () => {
  const page = new TrezorConnect({}, { info() {} });
  const confirmButton = {};
  let confirmationVisible = false;
  const clicks = [];

  page.findElements = async locator => {
    return locator === page.exportAccountsConfirmButtonLocator && confirmationVisible ? [confirmButton] : [];
  };
  page.customWaiter = async condition => {
    assert.equal(await condition(), false);
    confirmationVisible = true;
    return condition();
  };
  page.click = async locator => clicks.push(locator);
  page.clickByScript = async () => {
    throw new Error('WebUSB must not be activated by a script click');
  };

  await page.allowPubKeysExport();

  assert.deepEqual(clicks, [page.exportAccountsConfirmButtonLocator]);
});

test('uses real clicks through the v10 device prompt to account confirmation', async () => {
  const page = new TrezorConnect({}, { info() {} });
  const state = { prompt: 'waiting' };
  const clicks = [];

  page.findElements = async locator => {
    if (locator === page.connectTrezorButtonLocator && state.prompt === 'connect') return [{}];
    if (locator === page.findTrezorButtonLocator && state.prompt === 'find') return [{}];
    if (locator === page.exportAccountsConfirmButtonLocator && state.prompt === 'confirm') return [{}];
    return [];
  };
  page.customWaiter = async condition => {
    assert.equal(await condition(), false);
    state.prompt = 'connect';
    return condition();
  };
  page.waitForElement = async locator => {
    const expected = state.prompt === 'find' ? page.findTrezorButtonLocator : page.exportAccountsConfirmButtonLocator;
    assert.equal(locator, expected);
  };
  page.click = async locator => {
    clicks.push(locator);
    if (locator === page.connectTrezorButtonLocator) state.prompt = 'find';
    if (locator === page.findTrezorButtonLocator) state.prompt = 'confirm';
  };
  page.clickByScript = async () => {
    throw new Error('WebUSB must not be activated by a script click');
  };

  await page.allowPubKeysExport();

  assert.deepEqual(clicks, [
    page.connectTrezorButtonLocator,
    page.findTrezorButtonLocator,
    page.exportAccountsConfirmButtonLocator,
  ]);
});
