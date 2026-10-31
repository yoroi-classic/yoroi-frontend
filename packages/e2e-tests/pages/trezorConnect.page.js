import { defaultWaitTimeout, halfSecond } from '../helpers/timeConstants.js';
import BasePage from './basepage.js';

class TrezorConnect extends BasePage {
  // locators
  dontAskAgainCheckboxLocator = {
    locator: '.custom-checkbox',
    method: 'css',
  };
  analyticsToggleLocator = {
    locator: '[data-testid="@analytics/toggle-switch"]',
    method: 'css',
  };
  analyticsSwitchLocator = {
    locator: '[data-testid="@analytics/toggle-switch"] input[role="switch"]',
    method: 'css',
  };
  analyticsContinueButtonLocator = {
    locator: 'button[data-testid="@analytics/continue-button"]',
    method: 'css',
  };
  confirmUsingTrezorButtonLocator = {
    locator: 'button[data-testid="@connect-permissions-modal/confirm-button"], .confirm',
    method: 'css',
  };
  connectTrezorButtonLocator = {
    locator: '//button[normalize-space(.)="Connect Trezor"]',
    method: 'xpath',
  };
  legacyExportTrezorButtonLocator = {
    locator: '.confirm',
    method: 'css',
  };
  findTrezorButtonLocator = {
    locator: 'button[data-testid="web-usb-button"]',
    method: 'css',
  };
  exportAddressTitleTextLocator = {
    locator: '#container > div > div:nth-child(1) > h3',
    method: 'css',
  };
  exportAddressButtonLocator = {
    locator: 'button.confirm[data-testid="@export-address/confirm-button"]',
    method: 'css',
  };
  // functions
  async tickCheckbox() {
    this.logger.info(`TrezorConnect::tickCheckbox is called`);
    const consentScreenLoaded = await this.customWaiter(
      async () => {
        const analyticsToggles = await this.findElements(this.analyticsToggleLocator);
        if (analyticsToggles.length > 0) return true;
        const legacyCheckboxes = await this.findElements(this.dontAskAgainCheckboxLocator);
        return legacyCheckboxes.length === 4;
      },
      defaultWaitTimeout,
      halfSecond
    );
    if (!consentScreenLoaded) {
      this.logger.error(`TrezorConnect::tickCheckbox A consent screen is not found`);
      throw new Error('A consent screen is not found');
    }

    // Trezor Connect v10 shows an analytics-consent screen before the wallet
    // connection flow. Keep telemetry disabled in CI, then continue to the
    // existing connection-permission screen.
    const analyticsToggles = await this.findElements(this.analyticsToggleLocator);
    if (analyticsToggles.length > 0) {
      const analyticsSwitch = await this.findElement(this.analyticsSwitchLocator);
      const isAnalyticsEnabled = (await analyticsSwitch.getAttribute('aria-checked')) === 'true';
      if (isAnalyticsEnabled) {
        await this.clickElementByScript(analyticsToggles[0]);
      }
      await this.clickByScript(this.analyticsContinueButtonLocator);
      return;
    }

    const allCheckboxes = await this.findElements(this.dontAskAgainCheckboxLocator);
    // this conditions was found empirically
    await this.clickElementByScript(allCheckboxes[0]);
  }
  async allowConnection() {
    this.logger.info(`TrezorConnect::allowConnection is called`);
    await this.waitForElement(this.confirmUsingTrezorButtonLocator);
    await this.clickByScript(this.confirmUsingTrezorButtonLocator);
  }
  async allowPubKeysExport() {
    this.logger.info(`TrezorConnect::allowPubKeysExport is called`);
    const connectTrezorButtons = await this.findElements(this.connectTrezorButtonLocator);
    if (connectTrezorButtons.length > 0) {
      await this.clickElementByScript(connectTrezorButtons[0]);
      await this.waitForElement(this.findTrezorButtonLocator);
      await this.clickByScript(this.findTrezorButtonLocator);
      return;
    }

    await this.waitForElement(this.legacyExportTrezorButtonLocator);
    await this.clickByScript(this.legacyExportTrezorButtonLocator);
  }
  async exportAddressPageIsDisplayed() {
    this.logger.info(`TrezorConnect::exportAddressPageIsDisplayed is called`);
    return await this.customWaitIsPresented(this.exportAddressTitleTextLocator);
  }
  async confirmExportAddress() {
    this.logger.info(`TrezorConnect::exportAddressPageIsDisplayed is called`);
    await this.clickByScript(this.exportAddressButtonLocator);
  }
}

export default TrezorConnect;
