// @flow

import Config from '../../config';
import type { Manifest } from 'trezor-connect-flow';

declare var chrome: any;

/* eslint-disable no-restricted-properties */

export const TREZOR_CONNECT_REQUEST_TYPE = 'yoroi-trezor-connect';

type TrezorConnectApi = {|
  cardanoGetPublicKey: (params: any) => Promise<any>,
  cardanoGetAddress: (params: any) => Promise<any>,
  cardanoSignMessage: (params: any) => Promise<any>,
  cardanoSignTransaction: (params: any) => Promise<any>,
|};

export function getTrezorManifest(): Manifest {
  /** Starting from v7 Trezor Connect Manifest has been made mandatory
   * https://github.com/trezor/connect/blob/develop/docs/index.md#trezor-connect-manifest */
  const { manifest } = Config.wallets.hardwareWallet.trezorT;

  const trezorManifest: Manifest = {
    email: manifest.EMAIL,
    appUrl: manifest.appURL.CHROME,
    appName: manifest.appName,
  };

  return trezorManifest;
}

function sendTrezorRequest(method: string, params: Object): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: TREZOR_CONNECT_REQUEST_TYPE, method, params }, response => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
      } else if (!response || typeof response !== 'object') {
        reject(new Error('Trezor Connect returned no response'));
      } else {
        resolve(response);
      }
    });
  });
}

const trezorConnectProxy: TrezorConnectApi = {
  cardanoGetPublicKey: params => sendTrezorRequest('cardanoGetPublicKey', params),
  cardanoGetAddress: params => sendTrezorRequest('cardanoGetAddress', params),
  cardanoSignMessage: params => sendTrezorRequest('cardanoSignMessage', params),
  cardanoSignTransaction: params => sendTrezorRequest('cardanoSignTransaction', params),
};

export async function withTrezorConnect<T>(func: TrezorConnectApi => Promise<T>): Promise<T> {
  return func(trezorConnectProxy);
}
