import { useQuery } from '@tanstack/react-query';
import { YoroiRemoteConfig } from '../../types/yoroi';
import { YOROI_DEV_REMOTE_CONFIG_URL, YOROI_PROD_REMOTE_CONFIG_URL } from '../constants';
import { environment } from '../../../environment';

declare const CONFIG: {
  cardanoWalletBackend: {
    enabled: boolean;
    mainnet: string;
    preprod: string;
  };
};

type CardanoWalletBackendConfig = typeof CONFIG.cardanoWalletBackend;

export const getYoroiRemoteConfigUrl = (isDev: boolean, cardanoWalletBackend: CardanoWalletBackendConfig) => {
  const backend = isDev ? cardanoWalletBackend.preprod : cardanoWalletBackend.mainnet;
  if (cardanoWalletBackend.enabled && backend !== '') {
    return `${backend.replace(/\/+$/, '')}/v1/config`;
  }
  return isDev ? YOROI_DEV_REMOTE_CONFIG_URL : YOROI_PROD_REMOTE_CONFIG_URL;
};

export const useYoroiRemoteConfig = () => {
  const isDev = environment.isDev();
  const remoteConfigUrl = getYoroiRemoteConfigUrl(isDev, CONFIG.cardanoWalletBackend);

  return useQuery<YoroiRemoteConfig>({
    queryKey: ['yoroiRemoteConfig', remoteConfigUrl],
    queryFn: async () => {
      const res = await fetch(remoteConfigUrl);
      if (!res.ok) {
        throw new Error('Failed to fetch Yoroi remote config');
      }
      return res.json();
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 30, // v5: cacheTime -> gcTime (30 minutes)
  });
};
