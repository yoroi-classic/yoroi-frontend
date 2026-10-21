import axios from 'axios';
import { poolKeyHashHexToBech32 } from './lib/cardanoCrypto/cmlAddress';

const EXPLORER_API_BY_NETWORK: { [string]: string } = {
  mainnet: 'https://a.cexplorer.io/yoroi-api/',
  preprod: 'https://preprod.cexplorer.io/yoroi-api/',
  preview: 'https://preview.cexplorer.io/yoroi-api/',
};
const DEFAULT_SATURATION_THRESHOLD = 0.8;

const getPool = async (networkName, hash) => {
  const explorerApi = EXPLORER_API_BY_NETWORK[networkName];
  if (explorerApi == null) return null;
  const params = new URLSearchParams({ search: hash });
  const { data } = await axios.post(explorerApi, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!data.pools) return null;
  const [pool] = Object.values(data.pools);
  if (pool == null) return null;
  return {
    id: pool.id_bech,
    hash: pool.id,
    ticker: pool.db_ticker,
    name: pool.db_name,
    pic: typeof pool.pool_pic !== 'boolean' ? pool.pool_pic : null,
    stake: pool.total_stake,
    share: pool.total_size.toString(),
    roa: pool.roa,
    saturation: pool.saturation.toString(),
    taxFix: pool.tax_fix,
    taxRatio: pool.tax_ratio,
  };
};

export async function getPoolTransition(apiUrl, poolHashHex, networkName) {
  let transitionData;
  try {
    const response = await axios.get('/v2.1/pools/poolTransitionInfo', { baseURL: apiUrl });
    if (response.status === 200) transitionData = response.data;
  } catch (error) {
    console.error('Failed to resolve remote pool transition info', error);
    return null;
  }
  if (transitionData == null) return null;

  const poolId = poolKeyHashHexToBech32(poolHashHex);
  let suggestion = null;
  for (const groupName of Object.keys(transitionData.old)) {
    const oldEntry = transitionData.old[groupName].find(entry => entry[0] === poolId);
    if (oldEntry != null) {
      const [_, deadline, isEnabled] = oldEntry;
      const candidates = transitionData.new[groupName];
      suggestion = isEnabled && candidates != null ? { candidates, deadline } : null;
      break;
    }
  }
  if (suggestion == null) return null;

  let threshold = transitionData.saturationThreshold ?? DEFAULT_SATURATION_THRESHOLD;
  if (threshold < 0 || threshold > 1) {
    console.warn(
      `Incorrect saturation threshold value "${threshold}", expected between 0 and 1. Using default "${DEFAULT_SATURATION_THRESHOLD}"`
    );
    threshold = DEFAULT_SATURATION_THRESHOLD;
  }
  const current = await getPool(networkName, poolHashHex);
  let suggested = null;
  for (const candidateId of suggestion.candidates) {
    const candidate = await getPool(networkName, candidateId);
    if (candidate == null || Number(candidate.saturation) > threshold) continue;
    suggested = candidate;
    break;
  }
  if (current == null || suggested == null) return null;
  return { current, suggested, deadlineMilliseconds: suggestion.deadline };
}
