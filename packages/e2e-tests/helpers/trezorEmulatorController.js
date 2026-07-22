import ws from 'ws';
import { fiveSeconds, halfSecond, oneMinute } from './timeConstants.js';
import { isMacOS, sleep } from '../utils/utils.js';
import { TrezorModels } from './trezorHelper.js';
const { WebSocket } = ws;

class TrezorEmulatorControllerError extends Error {}

export class TrezorEmulatorController {
  websocketUrl = 'ws://localhost:9001/';
  id = 0;

  constructor(logger, { WebSocketImpl = WebSocket, responseTimeout = oneMinute / 2 } = {}) {
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.responseTimeout = responseTimeout;
    this.ws = null;
    this.model = null;
    this.label = null;
    this.pendingResponses = new Map();
    this.pendingEvents = [];
    this.queuedEvents = [];
  }

  isModelT = () => this.model === TrezorModels.ModelT;
  isSafe3 = () => this.model === TrezorModels.Safe3;
  isSafe5 = () => this.model === TrezorModels.Safe5;

  _getAddition = () => (isMacOS() ? '-arm' : '');

  _isSocketOpen() {
    return this.ws?.readyState === this.WebSocketImpl.OPEN;
  }

  _socketError(message) {
    return new TrezorEmulatorControllerError(message);
  }

  _clearPendingResponse(id) {
    const pending = this.pendingResponses.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResponses.delete(id);
    }
    return pending;
  }

  _rejectPending(error) {
    for (const [id, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingResponses.delete(id);
    }
    for (const pending of this.pendingEvents.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  _handleIncomingMessage(event) {
    let dataObject;
    try {
      dataObject = this.handleMessage(event);
    } catch (error) {
      this._rejectPending(error);
      return;
    }

    if (dataObject.background_check) {
      return;
    }

    if (dataObject.id !== undefined) {
      const pending = this._clearPendingResponse(dataObject.id);
      if (!pending) {
        this.logger.warn(`Ignoring response with unexpected id ${dataObject.id}`);
        return;
      }
      pending.resolve(dataObject);
      return;
    }

    const pendingEvent = this.pendingEvents.shift();
    if (pendingEvent) {
      clearTimeout(pendingEvent.timer);
      pendingEvent.resolve(dataObject);
    } else {
      this.queuedEvents.push(dataObject);
    }
  }

  _handleSocketFailure(error) {
    const reason = error instanceof Error ? error : this._socketError(`Trezor WebSocket failed: ${String(error)}`);
    this._rejectPending(reason);
  }

  _customPromise(json, functionName) {
    if (!this._isSocketOpen()) {
      return Promise.reject(this._socketError(`${functionName}: Trezor WebSocket is not open`));
    }

    return new Promise((resolve, reject) => {
      const requestId = this.id++;
      const timer = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(this._socketError(`${functionName}: no response after ${this.responseTimeout}ms`));
      }, this.responseTimeout);
      this.pendingResponses.set(requestId, { resolve, reject, timer });

      try {
        this._send(json, functionName, requestId);
      } catch (error) {
        this._clearPendingResponse(requestId);
        reject(error);
      }
    });
  }

  _innerConnect(websocketUrl, logger) {
    return new Promise((resolve, reject) => {
      const server = new this.WebSocketImpl(websocketUrl);
      let connected = false;
      const connectTimer = setTimeout(() => {
        if (connected) return;
        reject(this._socketError(`connect: no connection after ${this.responseTimeout}ms`));
        if (server.readyState === this.WebSocketImpl.CONNECTING || server.readyState === this.WebSocketImpl.OPEN) {
          server.close();
        }
      }, this.responseTimeout);
      server.onmessage = event => this._handleIncomingMessage(event);
      server.onopen = () => {
        connected = true;
        clearTimeout(connectTimer);
        logger.info(`_innerConnect: Connection is open`);
        resolve(server);
      };
      server.onerror = err => {
        logger.error(`_innerConnect: Connection is rejected. Reason: ${JSON.stringify(err)}`);
        if (!connected) {
          clearTimeout(connectTimer);
          reject(err);
        }
        this._handleSocketFailure(err);
      };
      server.onclose = () => {
        clearTimeout(connectTimer);
        if (this.ws === server) this.ws = null;
        const error = this._socketError('Trezor WebSocket closed');
        if (!connected) reject(error);
        this._handleSocketFailure(error);
      };
    });
  }

  async connect() {
    this.logger.info(`connect: Connecting to websocket ${this.websocketUrl}`);
    this.ws = await this._innerConnect(this.websocketUrl, this.logger);

    return this;
  }

  handleMessage(event) {
    if (!event.data || typeof event.data !== 'string') {
      this.logger.error(`handleMessage: Response received without proper data: ${event.data}`);
      throw new TrezorEmulatorControllerError(`Response received without proper data: ${event.data}`);
    }

    const dataObject = JSON.parse(event.data);

    if ('background_check' in dataObject && dataObject.background_check) {
      this.logger.info(`handleMessage: Background check`);
      return dataObject;
    }

    if ('success' in dataObject) {
      if (dataObject.success) {
        this.logger.info(`handleMessage: The response is successful`);
      } else {
        this.logger.error(`handleMessage: The response is fail`);
      }
    }

    return dataObject;
  }

  _send(json, functionName, requestId = this.id++) {
    if (!this._isSocketOpen()) {
      throw this._socketError(`${functionName}: Trezor WebSocket is not open`);
    }
    const requestToSend = JSON.stringify(
      Object.assign(json, {
        id: requestId,
      })
    );
    this.ws.send(requestToSend);
    this.logger.info(`${functionName}._send: Request sent: ${requestToSend}`);
  }

  _sendOnBackground(json) {
    if (!this._isSocketOpen()) {
      throw this._socketError('background request: Trezor WebSocket is not open');
    }
    this.ws.send(JSON.stringify(json));
  }

  closeWsConnection() {
    this.logger.info(`closeWsConnection: Closing the connection`);
    const server = this.ws;
    this.ws = null;
    this.queuedEvents = [];
    this._rejectPending(this._socketError('Trezor WebSocket closed'));
    if (server && (server.readyState === this.WebSocketImpl.CONNECTING || server.readyState === this.WebSocketImpl.OPEN)) {
      server.close();
    }
    this.logger.info(`closeWsConnection: The connection is closed`);
  }

  emulatorStart(trezorModel) {
    this.model = trezorModel;
    const requestJson = {
      type: 'emulator-start',
      version: `2-main${this._getAddition()}`,
      model: trezorModel, // T2T1 - Trezor Model T, T3T1 - Trezor Safe 5, T3B1 - Trezor Safe 3
    };

    return this._customPromise(requestJson, 'emulatorStart');
  }

  emulatorWipe() {
    const requestJson = {
      type: 'emulator-wipe',
    };

    return this._customPromise(requestJson, 'emulatorWipe');
  }

  emulatorResetDevice() {
    const requestJson = {
      type: 'emulator-reset-device',
    };

    return this._customPromise(requestJson, 'emulatorResetDevice');
  }

  emulatorResetDeviceShamir() {
    const requestJson = {
      type: 'emulator-reset-device',
      use_shamir: true,
    };

    return this._customPromise(requestJson, 'emulatorResetDeviceShamir');
  }

  emulatorSetup(mnemonic) {
    this.label = this.isModelT() ? 'Homescreen' : 'Emulator';
    const requestJson = {
      type: 'emulator-setup',
      mnemonic: mnemonic || 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      pin: '',
      passphrase_protection: false,
      label: 'Emulator',
    };

    return this._customPromise(requestJson, 'emulatorSetup');
  }

  emulatorPressYes() {
    const requestJson = {
      type: 'emulator-press-yes',
    };

    return this._customPromise(requestJson, 'emulatorPressYes');
  }

  emulatorSwipeUp() {
    const requestJson = {
      type: 'emulator-swipe',
      direction: 'up',
    };

    return this._customPromise(requestJson, 'emulatorSwipeUp');
  }

  emulatorSwipeDown() {
    const requestJson = {
      type: 'emulator-swipe',
      direction: 'down',
    };

    return this._customPromise(requestJson, 'emulatorSwipeDown');
  }

  emulatorPressNo() {
    const requestJson = {
      type: 'emulator-press-no',
    };

    return this._customPromise(requestJson, 'emulatorPressNo');
  }

  emulatorAllowUnsafe() {
    const requestJson = {
      type: 'emulator-allow-unsafe-paths',
    };

    return this._customPromise(requestJson, 'emulatorAllowUnsafe');
  }

  emulatorStop() {
    const requestJson = {
      type: 'emulator-stop',
    };

    return this._customPromise(requestJson, 'emulatorStop');
  }

  bridgeStart(bridgeVersion) {
    const requestJson = {
      type: 'bridge-start',
      version: bridgeVersion || `2.0.33${this._getAddition()}`,
    };

    return this._customPromise(requestJson, 'bridgeStart');
  }

  bridgeStop() {
    const requestJson = {
      type: 'bridge-stop',
    };

    return this._customPromise(requestJson, 'bridgeStop');
  }

  exit() {
    if (!this._isSocketOpen()) {
      return Promise.reject(this._socketError('exit: Trezor WebSocket is not open'));
    }

    return new Promise((resolve, reject) => {
      const server = this.ws;
      const previousOnClose = server.onclose;
      const previousOnError = server.onerror;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        if (server.onclose === onClose) server.onclose = previousOnClose;
        if (server.onerror === onError) server.onerror = previousOnError;
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onClose = event => {
        previousOnClose?.(event);
        finish(resolve, server);
      };
      const onError = err => {
        previousOnError?.(err);
        this.logger.error(`exit: The error is received:${err}`);
        finish(reject, this._socketError('exit: Trezor WebSocket failed'));
      };
      const timer = setTimeout(
        () => finish(reject, this._socketError(`exit: socket did not close after ${this.responseTimeout}ms`)),
        this.responseTimeout
      );
      server.onclose = onClose;
      server.onerror = onError;

      try {
        this._send({ type: 'exit' }, 'exit');
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  ping() {
    const requestJson = {
      type: 'ping',
    };

    return this._customPromise(requestJson, 'ping');
  }

  getLastEvent() {
    if (!this._isSocketOpen()) {
      return Promise.reject(this._socketError('getLastEvent: Trezor WebSocket is not open'));
    }
    const queued = this.queuedEvents.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject };
      pending.timer = setTimeout(() => {
        const index = this.pendingEvents.indexOf(pending);
        if (index >= 0) this.pendingEvents.splice(index, 1);
        reject(this._socketError(`getLastEvent: no event after ${this.responseTimeout}ms`));
      }, this.responseTimeout);
      this.pendingEvents.push(pending);
    });
  }

  readAndConfirmMnemonic() {
    const requestJson = {
      type: 'emulator-read-and-confirm-mnemonic',
    };

    return this._customPromise(requestJson, 'readAndConfirmMnemonic');
  }

  /**
   * Getting the current screen content
   * @returns {Promise<{title: string, body: string}>}
   */
  async getScreenContent() {
    const requestJson = {
      type: 'emulator-get-screen-content',
    };

    const content = await this._customPromise(requestJson, 'getScreenContent');

    return content.response;
  }

  /**
   * The function clicks "Yes" until all screens are confirmed. Also it collects all content from all shown screens and returns it in the end.
   * @returns {Promise<Array<string>>}
   */
  async fullConfirmAndGetContent() {
    const result = [];
    let content = await this.getScreenContent();
    const endTime = Date.now() + fiveSeconds;
    while (content.body === this.label) {
      if (Date.now() <= endTime) {
        sleep(halfSecond);
        content = await this.getScreenContent();
        continue;
      } else {
        throw new TrezorEmulatorControllerError('The Trezor device is not ready');
      }
    }
    while (content.body !== this.label) {
      result.push(content.body);
      if (this.isModelT() || this.isSafe3()) {
        await this.emulatorSwipeUp();
        const prevContent = result[result.length - 1];
        const afterSwipeContent = (await this.getScreenContent()).body;
        if (afterSwipeContent !== prevContent) {
          const newContent = prevContent + afterSwipeContent;
          result[result.length - 1] = newContent;
        }
      }
      await this.emulatorPressYes();
      content = await this.getScreenContent();
    }

    return result;
  }
}
