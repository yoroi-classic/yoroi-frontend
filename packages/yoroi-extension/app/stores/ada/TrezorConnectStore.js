// @flow
// Handles Connect to Trezor Hardware Wallet dialog

import { action, observable } from 'mobx';
import type { CardanoPublicKey, Success, TrezorFeatures, Unsuccessful } from 'trezor-connect-flow';
import TrezorConnect from 'trezor-connect-flow';
import Store from '../base/Store';
import globalMessages from '../../i18n/global-messages';
import LocalizableError, { UnexpectedError } from '../../i18n/LocalizableError';
import { CheckAddressesInUseApiError } from '../../api/common/errors';
import { wrapWithFrame } from '../lib/TrezorWrapper';
import { ROUTES } from '../../routes-config';
import Config from '../../config';
// This is actually just an interface
import { HWConnectStoreTypes, HWDeviceInfo, ProgressInfo, ProgressStep } from '../../types/HWConnectStoreTypes';
import { StepState } from '../../components/widgets/ProgressSteps';
import { Logger, stringifyError } from '../../utils/logging';
import { CoinTypes, HARD_DERIVATION_START, WalletTypePurpose } from '../../config/numbersConfig';
import { Bip44DerivationLevels } from '../../api/ada/lib/storage/database/walletTypes/bip44/api/utils';
import type { StoresMap } from '../index';
import { createHardwareWallet } from '../../api/thunk';
import type { CreateHardwareWalletRequest } from '../../api/thunk';
import type { WalletState } from '../../../chrome/extension/background/types';
// $FlowFixMe[cannot-resolve-module]
import { captureEvent } from '../../../posthog';

type TrezorConnectionResponse = {|
  trezorResp: Success<CardanoPublicKey> | Unsuccessful,
  trezorFeatures: ?TrezorFeatures,
|};

const isHexStringOfLength = (value: mixed, length: number): boolean =>
  typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);

const normalizeTrezorPublicKey = (payload: CardanoPublicKey): string => {
  const chainCode = payload.node?.chain_code;

  if (isHexStringOfLength(payload.publicKey, 128)) {
    return payload.publicKey;
  }

  if (isHexStringOfLength(payload.publicKey, 64) && isHexStringOfLength(chainCode, 64)) {
    return `${payload.publicKey}${chainCode}`;
  }

  if (isHexStringOfLength(payload.node?.public_key, 64) && isHexStringOfLength(chainCode, 64)) {
    return `${payload.node.public_key}${chainCode}`;
  }

  throw new Error(
    `Invalid extended public key received from Trezor device (public key: ${payload.publicKey?.length ?? 0} characters, ` +
      `node public key: ${payload.node?.public_key?.length ?? 0} characters, chain code: ${chainCode?.length ?? 0} characters)`
  );
};

export default class TrezorConnectStore extends Store<StoresMap> implements HWConnectStoreTypes<TrezorConnectionResponse> {
  // =================== VIEW RELATED =================== //
  /** the only observable which manages state change */
  @observable progressInfo: ProgressInfo;
  @observable derivationIndex: number = HARD_DERIVATION_START + 0; // assume single account

  /** only in ERROR state it will hold LocalizableError object */
  error: ?LocalizableError;

  get isActionProcessing(): boolean {
    return this.progressInfo.stepState === StepState.PROCESS;
  }

  // Trezor device label
  get defaultWalletName(): string {
    let defaultWalletName = '';
    if (this.hwDeviceInfo && this.hwDeviceInfo.hwFeatures) {
      defaultWalletName = this.hwDeviceInfo.defaultName;
    }
    return defaultWalletName;
  }

  /** device info which will be used to create wallet (except wallet name)
   * also it holds Trezor device label which is used as default wallet name
   * final wallet name will be fetched from the user */
  hwDeviceInfo: ?HWDeviceInfo;

  // =================== VIEW RELATED =================== //

  /** While trezor wallet creation is taking place, we need to block users from starting a
   * trezor wallet creation on a seperate wallet and explain to them why the action is blocked */
  @observable isCreateHWActive: boolean = false;
  // =================== API RELATED =================== //

  setup(): void {
    super.setup();
    this._reset();
  }

  /** setup() is called when stores are being created
   * _init() is called when connect dialog is about to show */
  init: void => void = () => {
    Logger.debug(`${nameof(TrezorConnectStore)}::${nameof(this.init)} called`);
  };

  teardown(): void {
    this._reset();
    super.teardown();
  }

  @action _reset: void => void = () => {
    this.progressInfo = {
      currentStep: ProgressStep.CHECK,
      stepState: StepState.LOAD,
    };
    this.error = undefined;
    this.hwDeviceInfo = undefined;
  };

  @action cancel: void => void = () => {
    this.teardown();
  };

  // =================== CHECK =================== //
  /** CHECK dialog submit(Next button) */
  @action submitCheck: void => void = () => {
    this.error = undefined;
    this.progressInfo.currentStep = ProgressStep.CONNECT;
    this.progressInfo.stepState = StepState.LOAD;
  };
  // =================== CHECK =================== //

  // =================== CONNECT =================== //
  /** CONNECT dialog goBack button */
  @action goBackToCheck: void => void = () => {
    this.error = undefined;
    this.progressInfo.currentStep = ProgressStep.CHECK;
    this.progressInfo.stepState = StepState.LOAD;
  };

  /** CONNECT dialog submit (Connect button) */
  @action submitConnect: void => Promise<void> = async () => {
    this.error = undefined;
    this.progressInfo.currentStep = ProgressStep.CONNECT;
    this.progressInfo.stepState = StepState.PROCESS;
    await this._checkAndStoreHWDeviceInfo();
  };

  @action _goToConnectError: void => void = () => {
    this.progressInfo.currentStep = ProgressStep.CONNECT;
    this.progressInfo.stepState = StepState.ERROR;
  };

  _checkAndStoreHWDeviceInfo: void => Promise<void> = async () => {
    try {
      this.hwDeviceInfo = undefined;

      const trezorConnection = await wrapWithFrame(async trezor => {
        const trezorResp = await trezor.cardanoGetPublicKey({
          path: this.getPath(),
          showOnTrezor: false,
        });
        const featuresResp = trezorResp.success ? await trezor.getFeatures() : undefined;
        return {
          trezorResp,
          trezorFeatures: featuresResp?.success ? featuresResp.payload : undefined,
        };
      });
      const { trezorResp, trezorFeatures } = trezorConnection;

      /** Converts a valid hardware wallet response to a common storable format
       * later the same format will be used to create wallet */
      this.hwDeviceInfo = this._normalizeHWResponse({ trezorResp, trezorFeatures });

      // It's a valid trezor device, go to Save Load state
      this._goToSaveLoad();

      /** TODO: [TREZOR] handle when user forcefully close Connect to Trezor Hardware Wallet
       * while connection in is progress */
      Logger.info('Trezor device OK');
    } catch (error) {
      this._handleConnectError(error);
    }
  };

  _normalizeHWResponse: TrezorConnectionResponse => HWDeviceInfo = resp => {
    this._validateHWResponse(resp);
    if (!resp.trezorResp.success) {
      throw new Error(`${nameof(TrezorConnectStore)}::${nameof(this._normalizeHWResponse)} should never happen`);
    }

    const { trezorResp, trezorFeatures } = resp;

    return {
      publicMasterKey: normalizeTrezorPublicKey(trezorResp.payload),
      hwFeatures: {
        Vendor: trezorFeatures?.vendor ?? Config.wallets.hardwareWallet.trezorT.VENDOR,
        Model: trezorFeatures?.model ?? Config.wallets.hardwareWallet.trezorT.MODEL,
        DeviceId: trezorFeatures?.device_id || '',
      },
      defaultName: trezorFeatures?.label || '',
    };
  };

  /** Validates the compatibility of data which we have received from Trezor device */
  _validateHWResponse: TrezorConnectionResponse => boolean = resp => {
    const { trezorResp } = resp;

    if (trezorResp && !trezorResp.success) {
      switch (trezorResp.payload.error) {
        case 'Iframe timeout':
          throw new LocalizableError(globalMessages.trezorError101);
        case 'Permissions not granted':
          throw new LocalizableError(globalMessages.hwError101);
        case 'Cancelled':
        case 'Popup closed':
          throw new LocalizableError(globalMessages.trezorError103);
        default:
          throw new Error(trezorResp.payload.error);
      }
    }

    if (
      trezorResp == null ||
      trezorResp.payload == null ||
      trezorResp.payload.publicKey == null ||
      trezorResp.payload.publicKey.length <= 0
    ) {
      throw new Error('Invalid public key received from Trezor device');
    }

    return true;
  };

  _handleConnectError: Error => void = error => {
    Logger.error(`${nameof(TrezorConnectStore)}::${nameof(this._handleConnectError)} ${stringifyError(error)}`);

    this.hwDeviceInfo = undefined;

    if (error instanceof LocalizableError) {
      this.error = error;
    } else {
      this.error = new UnexpectedError();
    }

    this._goToConnectError();
  };

  // =================== CONNECT =================== //

  // =================== SAVE =================== //
  @action _goToSaveLoad: void => void = () => {
    this.error = null;
    this.progressInfo.currentStep = ProgressStep.SAVE;
    this.progressInfo.stepState = StepState.LOAD;
    captureEvent('Connect Wallet Details Page Viewed');
  };

  /** SAVE dialog submit (Save button) */
  @action submitSave: string => Promise<void> = async walletName => {
    this.error = null;
    this.progressInfo.currentStep = ProgressStep.SAVE;
    this.progressInfo.stepState = StepState.PROCESS;

    await this._saveHW(walletName);
    captureEvent('Connect Wallet Details Submitted', { hardware_wallet: 'Trezor' });
  };

  /** creates new wallet and loads it */
  _saveHW: string => Promise<void> = async walletName => {
    try {
      Logger.debug(`${nameof(TrezorConnectStore)}::${nameof(this._saveHW)}:: stated`);
      this._setIsCreateHWActive(true);

      const reqParams = this._prepareCreateHWReqParams(walletName);

      const newWallet = await createHardwareWallet(reqParams);

      await this._onSaveSuccess(newWallet);
    } catch (error) {
      Logger.error(`${nameof(TrezorConnectStore)}::${nameof(this._saveHW)}::error ${stringifyError(error)}`);

      // Refer: https://github.com/Emurgo/yoroi-frontend/pull/1055
      if (error instanceof CheckAddressesInUseApiError) {
        /**
         * This error happens when yoroi could not fetch Used Address.
         * Mostly because internet not connected or yoroi backend is down.
         * At this point wallet is already created in the storage.
         * When internet connection is back, everything will be loaded correctly.
         */
        return;
      }

      if (error instanceof LocalizableError) {
        this.error = error;
      } else {
        // some unknown error
        this.error = new UnexpectedError();
      }
      this._goToSaveError();
    } finally {
      this._setIsCreateHWActive(false);
    }
  };

  _prepareCreateHWReqParams: string => CreateHardwareWalletRequest = walletName => {
    if (this.hwDeviceInfo == null || this.hwDeviceInfo.publicMasterKey == null || this.hwDeviceInfo.hwFeatures == null) {
      throw new Error('Trezor device hardware info not valid');
    }
    const { publicMasterKey, hwFeatures } = this.hwDeviceInfo;

    const { selectedNetwork } = this.stores.profile;
    if (selectedNetwork == null) throw new Error(`${nameof(this._prepareCreateHWReqParams)} no network selected`);

    return {
      addressing: {
        path: this.getPath(),
        startLevel: Bip44DerivationLevels.PURPOSE.level,
      },
      walletName,
      publicKey: publicMasterKey,
      hwFeatures,
      network: selectedNetwork,
    };
  };

  getPath: void => Array<number> = () => {
    return [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, this.derivationIndex];
  };

  @action _goToSaveError: void => void = () => {
    this.progressInfo.currentStep = ProgressStep.SAVE;
    this.progressInfo.stepState = StepState.ERROR;
  };

  _onSaveSuccess: WalletState => Promise<void> = async wallet => {
    // close the active dialog
    Logger.debug(`${nameof(TrezorConnectStore)}::${nameof(this._onSaveSuccess)} success, closing dialog`);
    this.stores.uiDialogs.closeActiveDialog();

    const { stores } = this;
    await stores.wallets.addHwWallet(wallet);
    stores.wallets.setActiveWallet({ publicDeriverId: wallet.publicDeriverId });
    stores.routing.goToRoute({ route: ROUTES.WALLETS.ROOT });

    // show success notification
    stores.wallets.showTrezorTWalletIntegratedNotification();

    this.teardown();
    Logger.info('SUCCESS: Trezor Connected Wallet created and loaded');
  };
  // =================== SAVE =================== //

  // =================== API =================== //
  @action _setIsCreateHWActive: boolean => void = active => {
    this.isCreateHWActive = active;
  };

  // this is used to inject test data
  // prettier-ignore
  setSelectedMockWallet: string => Promise<void> = async serial => {
    // $FlowExpectedError[prop-missing] only added in tests
    if (TrezorConnect.setSelectedWallet != null) { // eslint-disable-line no-restricted-properties
      // $FlowExpectedError[not-a-function] only added in tests
      await TrezorConnect.setSelectedWallet(serial); // eslint-disable-line no-restricted-properties
    }
  };
  // =================== API =================== //
}
