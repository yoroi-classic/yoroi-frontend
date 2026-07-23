// @flow

import type {
  ServerStatusRequest,
  ServerStatusResponse,
  CurrentCoinPriceRequest,
  CurrentCoinPriceResponse,
  HistoricalCoinPriceRequest,
  HistoricalCoinPriceResponse,
} from './types';

import type { IFetcher } from './IFetcher.types';
import { Logger, stringifyError } from '../../../../utils/logging';
import { ServerStatusError, CurrentCoinPriceError, HistoricalCoinPriceError } from '../../errors';
import { getNetworkById } from '../../../ada/lib/storage/database/prepackaged/networks';

import type { ConfigType } from '../../../../../config/config-types';

import { makeTimeoutAbortSignal, fetchAndEnsureSuccess } from '../../../utils';

// populated by ConfigWebpackPlugin
declare var CONFIG: ConfigType;

function getPriceBackendUrl(networkId: number): string {
  const network = getNetworkById(networkId);
  const endpoint = network.Backend.BackendService;
  if (endpoint == null) {
    throw new Error();
  }
  return endpoint;
}

function getEndpoint(networkId: number): string {
  // TODO: some currency-independent endpoint
  const network = getNetworkById(networkId);
  const endpoint = network.Backend.BackendService;
  if (endpoint == null) {
    throw new Error();
  }
  return endpoint;
}

function getCardanoWalletBackendEndpoint(networkId: number): null | string {
  if (!CONFIG.cardanoWalletBackend.enabled) return null;
  const network = getNetworkById(networkId);
  const endpoint =
    network.NetworkFeatureName === 'mainnet'
      ? CONFIG.cardanoWalletBackend.mainnet
      : network.NetworkFeatureName === 'preprod'
        ? CONFIG.cardanoWalletBackend.preprod
        : '';
  return endpoint === '' ? null : endpoint.replace(/\/+$/, '');
}

const ADA_PRICE_CURRENCIES = ['USD', 'JPY', 'EUR', 'CNY', 'KRW', 'BTC', 'ETH', 'BRL'];

function mapCardanoWalletBackendAdaPrice(response: any): CurrentCoinPriceResponse {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Invalid ADA price response');
  }

  const { prices, asOf } = response;
  if (prices == null || typeof prices !== 'object' || Array.isArray(prices)) {
    throw new Error('Invalid ADA prices');
  }
  if (!Number.isSafeInteger(asOf) || asOf <= 0) {
    throw new Error('Invalid ADA price timestamp');
  }

  const timestamp = asOf * 1000;
  const now = Date.now();
  if (timestamp > now) {
    throw new Error('Future ADA price timestamp');
  }
  if (now - timestamp > CONFIG.app.coinPriceFreshnessThreshold) {
    throw new Error('Stale ADA prices');
  }

  const validatedPrices = {};
  for (const currency of ADA_PRICE_CURRENCIES) {
    const price = prices[currency];
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new Error('Invalid ADA price');
    }
    validatedPrices[currency] = price;
  }

  return {
    error: null,
    ticker: {
      from: 'ADA',
      timestamp,
      prices: validatedPrices,
    },
  };
}

/**
 * Makes calls to Yoroi backend service
 * https://github.com/Emurgo/yoroi-backend-service/
 */
export class RemoteFetcher implements IFetcher {
  getLastLaunchVersion: () => string;
  getCurrentLocale: () => string;
  getPlatform: () => string;
  getCurrentNetworkId: () => number;

  constructor(
    getLastLaunchVersion: () => string,
    getCurrentLocale: () => string,
    getPlatform: () => string,
    getCurrentNetworkId: () => number
  ) {
    this.getLastLaunchVersion = getLastLaunchVersion;
    this.getCurrentLocale = getCurrentLocale;
    this.getPlatform = getPlatform;
    this.getCurrentNetworkId = getCurrentNetworkId;
  }

  checkServerStatus: ServerStatusRequest => Promise<ServerStatusResponse> = param => {
    const cardanoWalletBackend = getCardanoWalletBackendEndpoint(param.networkId);
    if (cardanoWalletBackend != null) {
      const expectedNetwork = getNetworkById(param.networkId).NetworkFeatureName;
      return fetchAndEnsureSuccess(`${cardanoWalletBackend}/v1/status`, {
        method: 'GET',
        signal: makeTimeoutAbortSignal(CONFIG.app.walletRefreshInterval),
        headers: {
          'yoroi-version': `${this.getPlatform()} / ${this.getLastLaunchVersion()}`,
          'yoroi-locale': this.getCurrentLocale(),
        },
      })
        .then(async response => {
          const status = await response.json();
          if (status.network !== expectedNetwork) {
            throw new Error(`cardano-wallet-backend serves ${String(status.network)}, expected ${String(expectedNetwork)}`);
          }

          const dateHeader = response.headers.get('date');
          const headerTime = dateHeader == null ? Number.NaN : Date.parse(dateHeader);
          const derivedTime =
            status.tip?.blockTime != null && Number.isFinite(status.behindSeconds)
              ? (status.tip.blockTime + status.behindSeconds) * 1000
              : Number.NaN;
          const serverTime = Number.isFinite(headerTime) ? headerTime : derivedTime;
          if (!Number.isFinite(serverTime)) {
            throw new Error('cardano-wallet-backend status has no usable server time');
          }

          return {
            isServerOk: true,
            isMaintenance: status.chain !== 'ok',
            serverTime,
          };
        })
        .catch(error => {
          Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.checkServerStatus)} v1 error: ` + stringifyError(error));
          throw new ServerStatusError();
        });
    }

    const backendUrl = param.backend || getEndpoint(this.getCurrentNetworkId());
    return fetchAndEnsureSuccess(`${backendUrl}/api/status`, {
      method: 'GET',
      signal: makeTimeoutAbortSignal(CONFIG.app.walletRefreshInterval),
      headers: {
        'yoroi-version': `${this.getPlatform()} / ${this.getLastLaunchVersion()}`,
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.checkServerStatus)} error: ` + stringifyError(error));
        throw new ServerStatusError();
      });
  };

  getCurrentCoinPrice: CurrentCoinPriceRequest => Promise<CurrentCoinPriceResponse> = body => {
    const cardanoWalletBackend = getCardanoWalletBackendEndpoint(this.getCurrentNetworkId());
    if (cardanoWalletBackend != null) {
      if (body.from !== 'ADA') {
        return Promise.reject(new CurrentCoinPriceError());
      }
      return fetchAndEnsureSuccess(`${cardanoWalletBackend}/v1/price/ada?currencies=${ADA_PRICE_CURRENCIES.join(',')}`, {
        method: 'GET',
        signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
        headers: {
          'yoroi-version': this.getLastLaunchVersion(),
          'yoroi-locale': this.getCurrentLocale(),
        },
      })
        .then(response => response.json())
        .then(mapCardanoWalletBackendAdaPrice)
        .catch(() => {
          Logger.error('RemoteFetcher::getCurrentCoinPrice v1 error');
          throw new CurrentCoinPriceError();
        });
    }

    const backendUrl = getPriceBackendUrl(this.getCurrentNetworkId());
    return fetchAndEnsureSuccess(`${backendUrl}/api/price/${body.from}/current`, {
      method: 'GET',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      headers: {
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error('RemoteFetcher::getCurrentCoinPrice error: ' + stringifyError(error));
        throw new CurrentCoinPriceError();
      });
  };

  getHistoricalCoinPrice: HistoricalCoinPriceRequest => Promise<HistoricalCoinPriceResponse> = body => {
    const backendUrl = getPriceBackendUrl(this.getCurrentNetworkId());
    return fetchAndEnsureSuccess(`${backendUrl}/api/price/${body.from}/${body.timestamps.join(',')}`, {
      method: 'GET',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      headers: {
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error('RemoteFetcher::getHistoricalCoinPrice error: ' + stringifyError(error));
        throw new HistoricalCoinPriceError();
      });
  };
}
