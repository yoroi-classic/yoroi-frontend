// @flow

import TrezorConnect from 'trezor-connect-flow';
import { getTrezorManifest, TREZOR_CONNECT_REQUEST_TYPE } from '../../../app/stores/lib/TrezorWrapper';

const supportedMethods = new Set(['cardanoGetPublicKey', 'cardanoGetAddress', 'cardanoSignMessage', 'cardanoSignTransaction']);

const callTrezorMethod = (method: string, params: any): Promise<any> => {
  switch (method) {
    case 'cardanoGetPublicKey':
      return TrezorConnect.cardanoGetPublicKey(params);
    case 'cardanoGetAddress':
      return TrezorConnect.cardanoGetAddress(params);
    case 'cardanoSignMessage':
      return TrezorConnect.cardanoSignMessage(params);
    case 'cardanoSignTransaction':
      return TrezorConnect.cardanoSignTransaction(params);
    default:
      return Promise.reject(new Error('Unsupported Trezor Connect method'));
  }
};

const failedResponse = error => ({
  success: false,
  payload: {
    error: error instanceof Error ? error.message : 'Trezor Connect request failed',
    code: 'TrezorConnectRequestError',
  },
});

export async function handleTrezorConnectMessage(message: any, sender: any): Promise<Object> {
  const extensionRoot = chrome.runtime.getURL('');
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string' || !sender.url.startsWith(extensionRoot)) {
    return failedResponse(new Error('Trezor Connect requests must come from a Yoroi extension page'));
  }

  if (
    message.type !== TREZOR_CONNECT_REQUEST_TYPE ||
    typeof message.method !== 'string' ||
    !supportedMethods.has(message.method) ||
    message.params === null ||
    typeof message.params !== 'object' ||
    Array.isArray(message.params)
  ) {
    return failedResponse(new Error('Invalid Trezor Connect request'));
  }

  try {
    await TrezorConnect.init({ manifest: getTrezorManifest() });
    try {
      return await callTrezorMethod(message.method, message.params);
    } finally {
      await TrezorConnect.dispose();
    }
  } catch (error) {
    return failedResponse(error);
  }
}
