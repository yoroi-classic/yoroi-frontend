type CardanoWalletBackendConfig = {
  enabled: boolean;
  mainnet: string;
  preprod: string;
};

export function getYoroiRemoteConfigUrl(
  isDev: boolean,
  cardanoWalletBackend: CardanoWalletBackendConfig,
  devRemoteConfigUrl: string,
  prodRemoteConfigUrl: string
): string;
