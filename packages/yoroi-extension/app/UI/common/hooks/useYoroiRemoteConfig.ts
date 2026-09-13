import { useQuery } from '@tanstack/react-query';
import { YoroiRemoteConfig } from '../../types/yoroi';
import { YOROI_DEV_REMOTE_CONFIG_URL, YOROI_PROD_REMOTE_CONFIG_URL } from '../constants';
import { environment } from '../../../environment';
import { getYoroiRemoteConfigUrl } from '../../../utils/yoroiRemoteConfigUrl';
import { parseYoroiRemoteConfig } from '../helpers/yoroiRemoteConfig';

declare const CONFIG: {
  cardanoWalletBackend: {
    enabled: boolean;
    mainnet: string;
    preprod: string;
  };
};

export const useYoroiRemoteConfig = () => {
  const isDev = environment.isDev() === true;
  const remoteConfigUrl = getYoroiRemoteConfigUrl(
    isDev,
    CONFIG.cardanoWalletBackend,
    YOROI_DEV_REMOTE_CONFIG_URL,
    YOROI_PROD_REMOTE_CONFIG_URL
  );

  return useQuery<YoroiRemoteConfig>({
    queryKey: ['yoroiRemoteConfig', remoteConfigUrl],
    queryFn: async (): Promise<YoroiRemoteConfig> => {
      const res = await fetch(remoteConfigUrl);
      if (!res.ok) {
        throw new Error('Failed to fetch Yoroi remote config');
      }
      const remoteConfig: unknown = await res.json();
      return parseYoroiRemoteConfig(remoteConfig);
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 30, // v5: cacheTime -> gcTime (30 minutes)
  });
};
