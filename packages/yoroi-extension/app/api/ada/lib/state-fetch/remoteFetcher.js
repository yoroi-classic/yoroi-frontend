// @flow

import type {
  AccountStateRequest,
  AccountStateResponse,
  RemoteAccountState,
  AddressUtxoRequest,
  AddressUtxoResponse,
  BestBlockRequest,
  BestBlockResponse,
  CatalystRoundInfoRequest,
  CatalystRoundInfoResponse,
  FilterUsedRequest,
  FilterUsedResponse,
  GetLatestBlockBySlotFunc,
  GetRecentTransactionHashesRequest,
  GetRecentTransactionHashesResponse,
  GetSwapFeeTiersFunc,
  GetSwapFeeTiersRequest,
  GetSwapFeeTiersResponse,
  GetTransactionsByHashesRequest,
  GetTransactionsByHashesResponse,
  GetTransactionSlotsByHashesResponse,
  GetUtxoDataRequest,
  GetUtxoDataResponse,
  HistoryRequest,
  HistoryResponse,
  MultiAssetMintMetadataResponse,
  MultiAssetRequest,
  MultiAssetSupplyResponse,
  PoolInfoRequest,
  PoolInfoResponse,
  RemoteTransaction,
  RewardHistoryRequest,
  RewardHistoryResponse,
  SignedRequest,
  SignedResponse,
  TokenInfoRequest,
  TokenInfoResponse,
} from './types';

import type { IFetcher } from './IFetcher.types';
import type { NetworkRow } from '../storage/database/primitives/tables';

import { Logger, stringifyError } from '../../../../utils/logging';
import {
  CheckAddressesInUseApiError,
  GetAccountStateApiError,
  GetBestBlockError,
  GetCatalystRoundInfoApiError,
  GetPoolInfoApiError,
  GetRewardHistoryApiError,
  GetTxHistoryForAddressesApiError,
  GetUtxoDataError,
  GetUtxosForAddressesApiError,
  InvalidWitnessError,
  RollbackApiError,
  SendTransactionApiError,
} from '../../../common/errors';

import type { ConfigType } from '../../../../../config/config-types';
import { bech32 } from 'bech32';
import { addressBech32ToHex, addressHexToBech32 } from '../cardanoCrypto/utils';
import { bytesToHex } from '../../../../coreUtils';
import { makeTimeoutAbortSignal, fetchAndEnsureSuccess, type ServerError } from '../../../utils';

// populated by ConfigWebpackPlugin
declare var CONFIG: ConfigType;

type CardanoWalletBackendTipResponse = {|
  block: number,
  slot: number,
  epoch: number,
  hash: string,
  blockTime: number,
|};

type CardanoWalletBackendAccountStateResponse = {|
  stakeAddress: string,
  registered: boolean,
  balance: string,
  rewardsAvailable: string,
  rewardsSum: string,
  withdrawalsSum: string,
  delegatedPool?: ?string,
  delegatedDrep?: ?string,
|};

export const cardanoWalletAccountStateToRemote = (
  response: CardanoWalletBackendAccountStateResponse,
  expectedStakeAddress: string
): RemoteAccountState => {
  if (response.stakeAddress !== expectedStakeAddress) {
    throw new Error('cardano-wallet-backend returned account state for a different stake address');
  }
  if (
    typeof response.registered !== 'boolean' ||
    typeof response.balance !== 'string' ||
    !/^\d+$/.test(response.balance) ||
    typeof response.rewardsAvailable !== 'string' ||
    !/^\d+$/.test(response.rewardsAvailable) ||
    typeof response.rewardsSum !== 'string' ||
    !/^\d+$/.test(response.rewardsSum) ||
    typeof response.withdrawalsSum !== 'string' ||
    !/^\d+$/.test(response.withdrawalsSum)
  ) {
    throw new Error('cardano-wallet-backend returned invalid account state');
  }
  let delegation = null;
  if (response.delegatedPool != null) {
    const decodedPool = bech32.decode(response.delegatedPool, 1000);
    const poolKeyHash = bech32.fromWords(decodedPool.words);
    if (decodedPool.prefix !== 'pool' || poolKeyHash.length !== 28) {
      throw new Error('cardano-wallet-backend returned an invalid delegated pool');
    }
    delegation = bytesToHex(poolKeyHash);
  }
  return {
    poolOperator: null,
    remainingAmount: response.rewardsAvailable,
    rewards: response.rewardsSum,
    withdrawals: response.withdrawalsSum,
    delegation,
    stakeRegistered: response.registered,
  };
};

export const cardanoWalletTipToBestBlock = (tip: CardanoWalletBackendTipResponse): BestBlockResponse => ({
  height: tip.block,
  epoch: tip.epoch,
  slot: tip.slot,
  hash: tip.hash,
});

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

const getCardanoWalletBackendService = (network: $ReadOnly<NetworkRow>): null | string => {
  if (!CONFIG.cardanoWalletBackend.enabled) return null;
  let backendService = '';
  if (network.NetworkFeatureName === 'mainnet') {
    backendService = CONFIG.cardanoWalletBackend.mainnet;
  } else if (network.NetworkFeatureName === 'preprod') {
    backendService = CONFIG.cardanoWalletBackend.preprod;
  }
  if (backendService === '') return null;
  return backendService;
};

export const sendTx: ({|
  body: SignedRequest,
  lastLaunchVersion: string,
  currentLocale: string,
  errorHandler?: ServerError => void,
|}) => Promise<SignedResponse> = ({ body, lastLaunchVersion, currentLocale, errorHandler }) => {
  const cardanoWalletBackendService = getCardanoWalletBackendService(body.network);
  if (cardanoWalletBackendService == null) {
    return Promise.reject(new SendTransactionApiError());
  }
  return fetchAndEnsureSuccess(`${withoutTrailingSlash(cardanoWalletBackendService)}/v1/tx/submit`, {
    method: 'POST',
    signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
    body: JSON.stringify({ cbor: bytesToHex(body.encodedTx) }),
    headers: {
      'content-type': 'application/json',
      'yoroi-version': lastLaunchVersion,
      'yoroi-locale': currentLocale,
    },
  })
    .then(response => response.json())
    .then(data => {
      if (typeof data.txHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(data.txHash)) {
        throw new Error('cardano-wallet-backend returned an invalid transaction hash');
      }
      return { txId: data.txHash };
    })
    .catch(error => handleSendTxError(error, errorHandler));
};

const handleSendTxError = (error: ServerError, errorHandler?: ServerError => void): Promise<SignedResponse> => {
  if (errorHandler != null) {
    errorHandler(error);
  }
  const err = {
    msg: error.message,
    res: error.response?.data || null,
  };
  Logger.error(`${nameof(RemoteFetcher)}::${nameof(sendTx)} error: ${stringifyError(err)}`);
  if (JSON.stringify(error.response?.data ?? '').includes('InvalidWitnessesUTXOW')) {
    throw new InvalidWitnessError();
  }
  throw new SendTransactionApiError();
};

export class RemoteFetcher implements IFetcher {
  getLastLaunchVersion: () => string;
  getCurrentLocale: () => string;
  getPlatform: () => string;

  constructor(getLastLaunchVersion: () => string, getCurrentLocale: () => string, getPlatform: () => string) {
    this.getLastLaunchVersion = getLastLaunchVersion;
    this.getCurrentLocale = getCurrentLocale;
    this.getPlatform = getPlatform;
  }

  getUTXOsForAddresses: AddressUtxoRequest => Promise<AddressUtxoResponse> = async body => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getUTXOsForAddresses)} missing backend url`);
    const result: AddressUtxoResponse = await fetchAndEnsureSuccess(`${BackendService}/api/txs/utxoForAddresses`, {
      method: 'POST',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      body: JSON.stringify({ addresses: body.addresses }),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getUTXOsForAddresses)} error: ` + stringifyError(error));
        throw new GetUtxosForAddressesApiError();
      });
    return result.map(utxo => {
      if (utxo.receiver.startsWith('addr')) {
        const fixedAddr = addressBech32ToHex(utxo.receiver);
        return {
          ...utxo,
          receiver: fixedAddr,
        };
      }
      return utxo;
    });
  };

  getTransactionsHistoryForAddresses: HistoryRequest => Promise<HistoryResponse> = body => {
    const { network, ...rest } = body;
    const { BackendService } = network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getTransactionsHistoryForAddresses)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/v2/txs/history`, {
      method: 'POST',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      body: JSON.stringify(rest),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .then(data => {
        return data.map((resp: RemoteTransaction) => {
          if (resp.type === 'shelley') {
            // unfortunately the backend returns Shelley addresses as bech32
            // this is a bad idea, and so we manually change them to raw payload
            for (const input of resp.inputs) {
              // replace non-existent w/ empty array to handle Allegra -> Mary transition
              // $FlowExpectedError[cannot-write]
              input.assets = input.assets ?? [];
              try {
                // $FlowExpectedError[cannot-write]
                input.address = bytesToHex(bech32.fromWords(bech32.decode(input.address, 1000).words));
              } catch (_e) {
                /* expected not to work for base58 addresses */
              }
            }
            for (const output of resp.outputs) {
              // replace non-existent w/ empty array to handle Allegra -> Mary transition
              // $FlowExpectedError[cannot-write]
              output.assets = output.assets ?? [];
              try {
                // $FlowExpectedError[cannot-write]
                output.address = bytesToHex(bech32.fromWords(bech32.decode(output.address, 1000).words));
              } catch (_e) {
                /* expected not to work for base58 addresses */
              }
            }
          }
          if (resp.height != null) {
            return resp;
          }
          // $FlowExpectedError[prop-missing] remove if we rename the field in the backend-service
          const height = resp.block_num;
          // $FlowExpectedError[prop-missing] remove if we rename the field in the backend-service
          delete resp.block_num;
          return {
            ...resp,
            height,
          };
        });
      })
      .catch(error => {
        Logger.error(
          `${nameof(RemoteFetcher)}::${nameof(this.getTransactionsHistoryForAddresses)} error: ` + stringifyError(error)
        );
        const errorMessage = error?.response?.data?.error?.response;
        if (
          errorMessage === 'REFERENCE_BLOCK_MISMATCH' ||
          errorMessage === 'REFERENCE_TX_NOT_FOUND' ||
          errorMessage === 'REFERENCE_BEST_BLOCK_MISMATCH'
        ) {
          throw new RollbackApiError();
        }
        throw new GetTxHistoryForAddressesApiError();
      });
  };

  getRecentTransactionHashes: GetRecentTransactionHashesRequest => Promise<GetRecentTransactionHashesResponse> = body => {
    const { network, addresses, before } = body;
    const { BackendService } = network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getRecentTransactionHashes)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/v2.1/txs/summaries`, {
      method: 'POST',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      body: JSON.stringify({ addresses, before }),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    }).then(response => response.json());
  };

  getTransactionsByHashes: GetTransactionsByHashesRequest => Promise<GetTransactionsByHashesResponse> = body => {
    const { network, txHashes } = body;
    const { BackendService } = network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getTransactionsByHashes)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/v2/txs/get`, {
      method: 'POST',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      body: JSON.stringify({ txHashes }),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .then(data => {
        return ((Object.values(data): any): Array<RemoteTransaction>).map((resp: RemoteTransaction) => {
          if (resp.type === 'shelley') {
            // unfortunately the backend returns Shelley addresses as bech32
            // this is a bad idea, and so we manually change them to raw payload
            for (const input of resp.inputs) {
              // replace non-existent w/ empty array to handle Allegra -> Mary transition
              // $FlowExpectedError[cannot-write]
              input.assets = input.assets ?? [];
              try {
                // $FlowExpectedError[cannot-write]
                input.address = bytesToHex(bech32.fromWords(bech32.decode(input.address, 1000).words));
              } catch (_e) {
                /* expected not to work for base58 addresses */
              }
            }
            for (const output of resp.outputs) {
              // replace non-existent w/ empty array to handle Allegra -> Mary transition
              // $FlowExpectedError[cannot-write]
              output.assets = output.assets ?? [];
              try {
                // $FlowExpectedError[cannot-write]
                output.address = bytesToHex(bech32.fromWords(bech32.decode(output.address, 1000).words));
              } catch (_e) {
                /* expected not to work for base58 addresses */
              }
            }
          }
          if (resp.height != null) {
            return resp;
          }
          // $FlowExpectedError[prop-missing] remove if we rename the field in the backend-service
          const height = resp.block_num;
          // $FlowExpectedError[prop-missing] remove if we rename the field in the backend-service
          delete resp.block_num;
          return {
            ...resp,
            height,
          };
        });
      });
  };

  getTransactionSlotsByHashes: GetTransactionsByHashesRequest => Promise<GetTransactionSlotsByHashesResponse> = body => {
    const { network, txHashes } = body;
    const { BackendService } = network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getTransactionsByHashes)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/v2.1/tx/status`, {
      method: 'POST',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      body: JSON.stringify({ txHashes }),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .then(data => data?.slot ?? {});
  };

  getRewardHistory: RewardHistoryRequest => Promise<RewardHistoryResponse> = body => {
    const { network, ...rest } = body;
    const { BackendService } = network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getRewardHistory)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/account/rewardHistory`, {
      method: 'POST',
      body: JSON.stringify(rest),
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getRewardHistory)} error: ` + stringifyError(error));
        throw new GetRewardHistoryApiError();
      });
  };

  getBestBlock: BestBlockRequest => Promise<BestBlockResponse> = body => {
    const cardanoWalletBackendService = getCardanoWalletBackendService(body.network);
    if (cardanoWalletBackendService != null) {
      return fetchAndEnsureSuccess(`${withoutTrailingSlash(cardanoWalletBackendService)}/v1/chain/tip`, {
        method: 'GET',
        signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
        headers: {
          'yoroi-version': this.getLastLaunchVersion(),
          'yoroi-locale': this.getCurrentLocale(),
        },
      })
        .then(response => response.json())
        .then(cardanoWalletTipToBestBlock)
        .catch(error => {
          Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getBestBlock)} v1 error: ` + stringifyError(error));
          throw new GetBestBlockError();
        });
    }

    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getBestBlock)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/v2/bestblock`, {
      method: 'GET',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      headers: {
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getBestBlock)} error: ` + stringifyError(error));
        throw new GetBestBlockError();
      });
  };

  sendTx: SignedRequest => Promise<SignedResponse> = body => {
    return sendTx({
      body,
      lastLaunchVersion: this.getLastLaunchVersion(),
      currentLocale: this.getCurrentLocale(),
    });
  };

  checkAddressesInUse: FilterUsedRequest => Promise<FilterUsedResponse> = body => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.checkAddressesInUse)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/v2/addresses/filterUsed`, {
      method: 'POST',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      body: JSON.stringify({ addresses: body.addresses }),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.checkAddressesInUse)} error: ` + stringifyError(error));
        throw new CheckAddressesInUseApiError();
      });
  };

  getAccountState: AccountStateRequest => Promise<AccountStateResponse> = body => {
    const cardanoWalletBackendService = getCardanoWalletBackendService(body.network);
    if (cardanoWalletBackendService == null) {
      return Promise.reject(new GetAccountStateApiError());
    }

    return Promise.all(
      body.addresses.map(async address => {
        const stakeAddress = addressHexToBech32(address);
        const response: CardanoWalletBackendAccountStateResponse = await fetchAndEnsureSuccess(
          `${withoutTrailingSlash(cardanoWalletBackendService)}/v1/account/${encodeURIComponent(stakeAddress)}/state`,
          {
            method: 'GET',
            signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
            headers: {
              'yoroi-version': this.getLastLaunchVersion(),
              'yoroi-locale': this.getCurrentLocale(),
            },
          }
        ).then(result => result.json());
        return ([address, cardanoWalletAccountStateToRemote(response, stakeAddress)]: [string, RemoteAccountState]);
      })
    )
      .then(entries =>
        entries.reduce((accountState: AccountStateResponse, [address, state]) => {
          accountState[address] = state;
          return accountState;
        }, {})
      )
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getAccountState)} error: ` + stringifyError(error));
        throw new GetAccountStateApiError();
      });
  };

  getPoolInfo: PoolInfoRequest => Promise<PoolInfoResponse> = body => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getPoolInfo)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/pool/info`, {
      method: 'POST',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      body: JSON.stringify({ poolIds: body.poolIds }),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getPoolInfo)} error: ` + stringifyError(error));
        throw new GetPoolInfoApiError();
      });
  };

  getTokenInfo: TokenInfoRequest => Promise<TokenInfoResponse> = async body => {
    const { TokenInfoService } = body.network.Backend;
    if (TokenInfoService == null) return {};
    const promises = body.tokenIds.map(id =>
      fetchAndEnsureSuccess(`${TokenInfoService}/metadata/${id}`, {
        method: 'GET',
        signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      })
        .then(response => response.json())
        .then(data => ({ error: null, data }))
        .catch(error => {
          if (error.response?.status === 404) {
            return { error: 'noMetadata', data: id };
          }
          Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getTokenInfo)} error: ` + stringifyError(error));
          return { error: 'fail', data: null };
        })
    );
    // return the mapping from query id/subject to token info
    // if there is no info about a token (not an error), the value is null
    // if there is an error querying a token, the key is not present
    return (await Promise.all(promises)).reduce((res, resp) => {
      if (resp.error === 'noMetadata') {
        res[resp.data] = null;
      } else if (!resp.error && resp.data.subject) {
        const v = {};
        if (resp.data.name?.value) {
          v.name = resp.data.name.value;
        }
        if (resp.data.decimals?.value) {
          v.decimals = resp.data.decimals.value;
        }
        if (resp.data.ticker?.value) {
          v.ticker = resp.data.ticker.value;
        }
        if (resp.data.logo?.value) {
          v.logo = resp.data.logo.value;
        }
        if (v.name || v.decimals || v.ticker || v.logo) {
          res[resp.data.subject] = v;
        }
      }
      return res;
    }, {});
  };

  getCatalystRoundInfo: CatalystRoundInfoRequest => Promise<CatalystRoundInfoResponse> = async body => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getCatalystRoundInfo)} missing backend url`);
    return await fetchAndEnsureSuccess(`${BackendService}/api/v0/catalyst/fundInfo`, {
      method: 'GET',
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getCatalystRoundInfo)} error: ` + stringifyError(error));
        throw new GetCatalystRoundInfoApiError();
      });
  };

  getMultiAssetMintMetadata: MultiAssetRequest => Promise<MultiAssetMintMetadataResponse> = async body => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getMultiAssetMintMetadata)} missing backend url`);
    return await fetchAndEnsureSuccess(`${BackendService}/api/multiAsset/metadata`, {
      method: 'POST',
      body: JSON.stringify({
        assets: body.assets,
      }),
      headers: {
        'content-type': 'application/json',
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getMultiAssetMintMetadata)} error: ` + stringifyError(error));
        return {};
      });
  };

  getMultiAssetSupply: MultiAssetRequest => Promise<MultiAssetSupplyResponse> = async body => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getMultiAssetSupply)} missing backend url`);
    return await fetchAndEnsureSuccess(`${BackendService}/api/multiAsset/supply?numberFormat=string`, {
      method: 'POST',
      body: JSON.stringify({
        assets: body.assets,
      }),
      headers: {
        'content-type': 'application/json',
      },
    })
      .then(response => response.json())
      .then(data => data.supplies)
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getMultiAssetSupply)} error: ` + stringifyError(error));
        return {};
      });
  };

  getUtxoData: GetUtxoDataRequest => Promise<GetUtxoDataResponse> = async body => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getUtxoData)} missing backend url`);
    return Promise.all(
      body.utxos.map(({ txHash, txIndex }) => {
        return fetchAndEnsureSuccess(`${BackendService}/api/txs/io/${txHash}/o/${txIndex}`, {
          method: 'GET',
          signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
          headers: {
            'yoroi-version': this.getLastLaunchVersion(),
            'yoroi-locale': this.getCurrentLocale(),
          },
        })
          .then(response => response.json())
          .catch(error => {
            if (error.response.status === 404 && error.response.data === 'No outputs found') {
              return null;
            }
            Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getUtxoData)} error: ` + stringifyError(error));
            throw new GetUtxoDataError();
          });
      })
    );
  };

  getLatestBlockBySlot: GetLatestBlockBySlotFunc = async body => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getLatestBlockBySlot)} missing backend url`);
    return fetchAndEnsureSuccess(`${BackendService}/api/v2.1/lastBlockBySlot`, {
      method: 'POST',
      body: JSON.stringify({ slots: body.slots }),
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getCatalystRoundInfo)} error: ` + stringifyError(error));
        return {
          blockHashes: {},
        };
      });
  };

  getSwapFeeTiers: GetSwapFeeTiersFunc = async (body: GetSwapFeeTiersRequest): Promise<GetSwapFeeTiersResponse> => {
    const { BackendService } = body.network.Backend;
    if (BackendService == null) throw new Error(`${nameof(this.getSwapFeeTiers)} missing backend url`);
    return await fetchAndEnsureSuccess(`${BackendService}/api/v2.1/swap/feesInfo`, {
      method: 'GET',
    })
      .then(response => response.json())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getCatalystRoundInfo)} error: ` + stringifyError(error));
        throw new GetCatalystRoundInfoApiError();
      });
  };
}
