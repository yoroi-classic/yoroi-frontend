type CardanoWalletBackendConfig = {
  enabled: boolean;
  mainnet: string;
  preprod: string;
};

export const getYoroiRemoteConfigUrl = (
  isDev: boolean,
  cardanoWalletBackend: CardanoWalletBackendConfig,
  devRemoteConfigUrl: string,
  prodRemoteConfigUrl: string
): string => {
  const backend = isDev ? cardanoWalletBackend.preprod : cardanoWalletBackend.mainnet;
  if (cardanoWalletBackend.enabled && backend !== '') {
    return `${backend.replace(/\/+$/, '')}/v1/config`;
  }
  return isDev ? devRemoteConfigUrl : prodRemoteConfigUrl;
};
