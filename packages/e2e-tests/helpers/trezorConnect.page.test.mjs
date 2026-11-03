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
  let state = 'waiting';
  const clicks = [];

  page.findElements = async locator => {
    if (locator === page.exportAccountsConfirmButtonLocator && state === 'export') return [{}];
    if (locator === page.connectPermissionsConfirmButtonLocator && state === 'permissions') return [{}];
    return [];
  };
  page.customWaiter = async condition => {
    assert.equal(await condition(), false);
    state = 'export';
    return condition();
  };
  page.waitForElement = async locator => {
    assert.equal(locator, page.connectPermissionsConfirmButtonLocator);
  };
  page.click = async locator => {
    clicks.push(locator);
    if (locator === page.exportAccountsConfirmButtonLocator) state = 'permissions';
  };
  page.clickByScript = async () => {
    throw new Error('WebUSB must not be activated by a script click');
  };

  await page.allowPubKeysExport();

  assert.deepEqual(clicks, [page.exportAccountsConfirmButtonLocator, page.connectPermissionsConfirmButtonLocator]);
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
    const expected =
      state.prompt === 'find'
        ? page.findTrezorButtonLocator
        : state.prompt === 'confirm'
          ? page.exportAccountsConfirmButtonLocator
          : page.connectPermissionsConfirmButtonLocator;
    assert.equal(locator, expected);
  };
  page.click = async locator => {
    clicks.push(locator);
    if (locator === page.connectTrezorButtonLocator) state.prompt = 'find';
    if (locator === page.findTrezorButtonLocator) state.prompt = 'confirm';
    if (locator === page.exportAccountsConfirmButtonLocator) state.prompt = 'permissions';
  };
  page.clickByScript = async () => {
    throw new Error('WebUSB must not be activated by a script click');
  };

  await page.allowPubKeysExport();

  assert.deepEqual(clicks, [
    page.connectTrezorButtonLocator,
    page.findTrezorButtonLocator,
    page.exportAccountsConfirmButtonLocator,
    page.connectPermissionsConfirmButtonLocator,
  ]);
});

test('confirms the address permission and complete account-export prompt flow', async () => {
  const page = new TrezorConnect({}, { info() {} });
  const state = { prompt: 'permissions' };
  const clicks = [];

  page.findElements = async locator => {
    if (
      locator === page.connectPermissionsConfirmButtonLocator &&
      (state.prompt === 'permissions' || state.prompt === 'final-permissions')
    )
      return [{}];
    if (locator === page.exportAccountsConfirmButtonLocator && state.prompt === 'accounts') return [{}];
    if (locator === page.exportAddressTitleTextLocator && state.prompt === 'address') return [{}];
    return [];
  };
  page.waitForElement = async locator => {
    assert.equal(locator, page.exportAccountsConfirmButtonLocator);
  };
  page.customWaiter = async condition => condition();
  page.click = async locator => {
    clicks.push(locator);
    if (locator === page.connectPermissionsConfirmButtonLocator) {
      state.prompt = state.prompt === 'permissions' ? 'accounts' : 'address';
    }
    if (locator === page.exportAccountsConfirmButtonLocator) state.prompt = 'final-permissions';
  };
  page.allowPubKeysExport = async () => {
    throw new Error('The address permission flow must be handled directly');
  };

  await page.allowAddressExport();

  assert.deepEqual(clicks, [
    page.connectPermissionsConfirmButtonLocator,
    page.exportAccountsConfirmButtonLocator,
    page.connectPermissionsConfirmButtonLocator,
  ]);
});
