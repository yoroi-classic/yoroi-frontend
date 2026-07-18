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
  SendTransactionApiError,
} from '../../../common/errors';

import type { ConfigType } from '../../../../../config/config-types';
import { bech32 } from 'bech32';
import { addressBech32ToHex, addressHexToBech32 } from '../cardanoCrypto/utils';
import { addressToDisplayString } from '../storage/bridge/utils';
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

type CardanoWalletBackendUtxo = {|
  txHash: string,
  outputIndex: number,
  address: string,
  value: string,
  assets: Array<{|
    policyId: string,
    assetName: string,
    quantity: string,
  |}>,
|};

const toCardanoWalletBackendAddress = (address: string, network: $ReadOnly<NetworkRow>): string => {
  // Wallet storage uses hex for Shelley addresses and base58 for Byron addresses,
  // while the backend accepts the chain's display encodings.
  if (/^(?:[0-9a-f]{2})+$/i.test(address)) {
    return addressToDisplayString(address, network);
  }
  return address;
};

export const cardanoWalletAccountStateToRemote = (
  response: CardanoWalletBackendAccountStateResponse,
  expectedStakeAddress: string
): RemoteAccountState => {
  if (response.stakeAddress !== expectedStakeAddress) {
    throw new Error('cardano-wallet-backend returned account state for a different stake address');
  }
  if (
    typeof response.registered !== 'boolean' ||
    !/^\d+$/.test(response.rewardsAvailable) ||
    !/^\d+$/.test(response.rewardsSum) ||
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

const ensureCardanoWalletBackendHistoryIsEmpty = async ({
  service,
  network,
  addresses,
  after,
  headers,
}: {|
  service: string,
  network: $ReadOnly<NetworkRow>,
  addresses: Array<string>,
  after?: number,
  headers: { [string]: string },
|}): Promise<void> => {
  const backendAddresses = addresses.map(address => toCardanoWalletBackendAddress(address, network));
  const stakeAddresses = backendAddresses.filter(address => address.startsWith('stake'));
  // A stake-account read already covers every payment key in a Shelley account. The backend
  // accepts addr_vkh for discovery but not for UTxO/history reads, so do not duplicate those
  // account reads through the address-set endpoint.
  const paymentAddresses = backendAddresses.filter(
    address => !address.startsWith('stake') && !(stakeAddresses.length !== 0 && address.startsWith('addr_vkh'))
  );
  const afterQuery = after === undefined ? '' : `?after=${after}`;
  const requests = [
    ...(paymentAddresses.length === 0
      ? []
      : [
          fetchAndEnsureSuccess(`${withoutTrailingSlash(service)}/v1/addresses/txs`, {
            method: 'POST',
            signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
            body: JSON.stringify({
              addresses: paymentAddresses,
              ...(after === undefined ? {} : { after }),
            }),
            headers: { 'content-type': 'application/json', ...headers },
          }).then(response => response.json()),
        ]),
    ...stakeAddresses.map(stakeAddress =>
      fetchAndEnsureSuccess(`${withoutTrailingSlash(service)}/v1/account/${encodeURIComponent(stakeAddress)}/txs${afterQuery}`, {
        method: 'GET',
        signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
        headers,
      }).then(response => response.json())
    ),
  ];
  const histories = await Promise.all(requests);
  if (histories.some(history => !Array.isArray(history))) {
    throw new Error('cardano-wallet-backend returned invalid history');
  }
  // The v1 transaction IO contract does not yet include spent-output references required by
  // RemoteTransactionInput. Empty histories are complete and safe; non-empty histories fail
  // closed until the backend exposes those references.
  if (histories.some(history => history.length !== 0)) {
    throw new Error('cardano-wallet-backend history needs input references');
  }
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
    .then(data => ({ txId: data.txHash }))
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
    const cardanoWalletBackendService = getCardanoWalletBackendService(body.network);
    if (cardanoWalletBackendService == null) {
      throw new GetUtxosForAddressesApiError();
    }
    const backendAddresses = body.addresses.map(address => toCardanoWalletBackendAddress(address, body.network));
    const stakeAddresses = backendAddresses.filter(address => address.startsWith('stake'));
    const paymentAddresses = backendAddresses.filter(
      address => !address.startsWith('stake') && !(stakeAddresses.length !== 0 && address.startsWith('addr_vkh'))
    );
    const headers = {
      'yoroi-version': this.getLastLaunchVersion(),
      'yoroi-locale': this.getCurrentLocale(),
    };
    const result: Array<CardanoWalletBackendUtxo> = await Promise.all([
      ...(paymentAddresses.length === 0
        ? []
        : [
            fetchAndEnsureSuccess(`${withoutTrailingSlash(cardanoWalletBackendService)}/v1/addresses/utxos`, {
              method: 'POST',
              signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
              body: JSON.stringify({ addresses: paymentAddresses }),
              headers: { 'content-type': 'application/json', ...headers },
            }).then(response => response.json()),
          ]),
      ...stakeAddresses.map(stakeAddress =>
        fetchAndEnsureSuccess(
          `${withoutTrailingSlash(cardanoWalletBackendService)}/v1/account/${encodeURIComponent(stakeAddress)}/utxos`,
          {
            method: 'GET',
            signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
            headers,
          }
        ).then(response => response.json())
      ),
    ])
      .then(results => results.flat())
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getUTXOsForAddresses)} v1 error: ` + stringifyError(error));
        throw new GetUtxosForAddressesApiError();
      });
    return result.map(utxo => {
      if (
        typeof utxo.txHash !== 'string' ||
        !Number.isSafeInteger(utxo.outputIndex) ||
        utxo.outputIndex < 0 ||
        typeof utxo.address !== 'string' ||
        !/^\d+$/.test(utxo.value) ||
        !Array.isArray(utxo.assets)
      ) {
        throw new GetUtxosForAddressesApiError();
      }
      const receiver = utxo.address.startsWith('addr') ? addressBech32ToHex(utxo.address) : utxo.address;
      return {
        utxo_id: `${utxo.txHash}${utxo.outputIndex}`,
        tx_hash: utxo.txHash,
        tx_index: utxo.outputIndex,
        receiver,
        amount: utxo.value,
        assets: utxo.assets.map(asset => ({
          amount: asset.quantity,
          assetId: `${asset.policyId}.${asset.assetName}`,
          policyId: asset.policyId,
          name: asset.assetName,
        })),
      };
    });
  };

  getTransactionsHistoryForAddresses: HistoryRequest => Promise<HistoryResponse> = body => {
    const cardanoWalletBackendService = getCardanoWalletBackendService(body.network);
    if (cardanoWalletBackendService == null) {
      return Promise.reject(new GetTxHistoryForAddressesApiError());
    }
    const after = body.after?.block == null ? undefined : Number(body.after.block);
    if (after !== undefined && !Number.isSafeInteger(after)) {
      return Promise.reject(new GetTxHistoryForAddressesApiError());
    }
    return ensureCardanoWalletBackendHistoryIsEmpty({
      service: cardanoWalletBackendService,
      network: body.network,
      addresses: body.addresses,
      after,
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(() => [])
      .catch(error => {
        Logger.error(
          `${nameof(RemoteFetcher)}::${nameof(this.getTransactionsHistoryForAddresses)} v1 error: ` + stringifyError(error)
        );
        throw new GetTxHistoryForAddressesApiError();
      });
  };

  getRecentTransactionHashes: GetRecentTransactionHashesRequest => Promise<GetRecentTransactionHashesResponse> = body => {
    const cardanoWalletBackendService = getCardanoWalletBackendService(body.network);
    if (cardanoWalletBackendService == null) {
      return Promise.reject(new GetTxHistoryForAddressesApiError());
    }
    return ensureCardanoWalletBackendHistoryIsEmpty({
      service: cardanoWalletBackendService,
      network: body.network,
      addresses: body.addresses,
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(() => ({}))
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getRecentTransactionHashes)} v1 error: ` + stringifyError(error));
        throw new GetTxHistoryForAddressesApiError();
      });
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
    const cardanoWalletBackendService = getCardanoWalletBackendService(body.network);
    if (cardanoWalletBackendService == null) return Promise.reject(new GetRewardHistoryApiError());
    return Promise.all(
      body.addresses.map(async address => {
        const stakeAddress = addressHexToBech32(address);
        const rewards = await fetchAndEnsureSuccess(
          `${withoutTrailingSlash(cardanoWalletBackendService)}/v1/account/${encodeURIComponent(stakeAddress)}/rewards`,
          {
            method: 'GET',
            signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
            headers: {
              'yoroi-version': this.getLastLaunchVersion(),
              'yoroi-locale': this.getCurrentLocale(),
            },
          }
        ).then(response => response.json());
        if (!Array.isArray(rewards)) throw new Error('cardano-wallet-backend returned invalid rewards');
        return [
          address,
          rewards.map(reward => {
            if (!Number.isSafeInteger(reward.earnedEpoch) || !/^\d+$/.test(reward.amount)) {
              throw new Error('cardano-wallet-backend returned invalid reward');
            }
            let poolHash = '';
            if (reward.poolId != null) {
              const decoded = bech32.decode(reward.poolId, 1000);
              if (decoded.prefix !== 'pool') throw new Error('cardano-wallet-backend returned invalid reward pool');
              poolHash = bytesToHex(bech32.fromWords(decoded.words));
            }
            return { epoch: reward.earnedEpoch, reward: reward.amount, poolHash };
          }),
        ];
      })
    )
      .then(entries => Object.fromEntries(entries))
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.getRewardHistory)} v1 error: ` + stringifyError(error));
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
    const cardanoWalletBackendService = getCardanoWalletBackendService(body.network);
    if (cardanoWalletBackendService == null) {
      return Promise.reject(new CheckAddressesInUseApiError());
    }
    const backendToStoredAddress = new Map(
      body.addresses.map(address => [toCardanoWalletBackendAddress(address, body.network), address])
    );
    return fetchAndEnsureSuccess(`${withoutTrailingSlash(cardanoWalletBackendService)}/v1/addresses/filter-used`, {
      method: 'POST',
      signal: makeTimeoutAbortSignal(2 * CONFIG.app.walletRefreshInterval),
      body: JSON.stringify({ addresses: Array.from(backendToStoredAddress.keys()) }),
      headers: {
        'content-type': 'application/json',
        'yoroi-version': this.getLastLaunchVersion(),
        'yoroi-locale': this.getCurrentLocale(),
      },
    })
      .then(response => response.json())
      .then(response => {
        if (
          !Array.isArray(response) ||
          response.some(address => typeof address !== 'string' || !backendToStoredAddress.has(address))
        ) {
          throw new Error('cardano-wallet-backend returned invalid used addresses');
        }
        return response.map(address => backendToStoredAddress.get(address)).filter(Boolean);
      })
      .catch(error => {
        Logger.error(`${nameof(RemoteFetcher)}::${nameof(this.checkAddressesInUse)} v1 error: ` + stringifyError(error));
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
