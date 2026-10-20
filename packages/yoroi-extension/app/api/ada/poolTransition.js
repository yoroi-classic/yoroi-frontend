import axios from 'axios';
import { poolKeyHashHexToBech32 } from './lib/cardanoCrypto/cmlAddress';

const EXPLORER_API = 'https://a.cexplorer.io/yoroi-api/';
const DEFAULT_SATURATION_THRESHOLD = 0.8;

const getPool = async hash => {
  const params = new URLSearchParams({ search: hash });
  const { data } = await axios.post(EXPLORER_API, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!data.pools) return null;
  const [pool] = Object.values(data.pools);
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

export async function getPoolTransition(apiUrl, poolHashHex) {
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
    console.warn(`Incorrect saturation threshold value "${threshold}", expected between 0 and 1. Using default "${DEFAULT_SATURATION_THRESHOLD}"`);
    threshold = DEFAULT_SATURATION_THRESHOLD;
  }
  const current = await getPool(poolHashHex);
  let suggested = null;
  for (const candidateId of suggestion.candidates) {
    suggested = await getPool(candidateId);
    if (suggested == null || Number(suggested.saturation) > threshold) continue;
    break;
  }
  if (current == null || suggested == null) return null;
  return { current, suggested, deadlineMilliseconds: suggestion.deadline };
}
