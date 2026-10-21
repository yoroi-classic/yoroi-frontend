// @flow

import Config from '../../config';
import TrezorConnect from 'trezor-connect-flow';
import type { Manifest } from 'trezor-connect-flow';

/* eslint-disable no-restricted-properties */

/*
 * Trezor needs to embed an iframe inside Yoroi to function (created by TrezorConnect.init)
 * Some TrezorConnect functions depend on this iframe existing, while others don't
 * Goal: want to only keep the Trezor iframe open for the least amount of time for safety & privacy
 *
 * To do this safely, we disallow the usage of TrezorConnect in the whole codebase
 * except for this function that exposes wrapper functions
 * that forces the programmer to explicitly decide to initialize the iframe or not
 */

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

export async function wrapWithFrame<T>(func: (typeof TrezorConnect) => Promise<T>): Promise<T> {
  const trezorManifest = getTrezorManifest();
  await TrezorConnect.init({
    manifest: trezorManifest,
  });
  try {
    return await func(TrezorConnect);
  } finally {
    await TrezorConnect.dispose();
  }
}
