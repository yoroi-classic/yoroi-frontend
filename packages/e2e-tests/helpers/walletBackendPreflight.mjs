import { pathToFileURL } from 'node:url';

const withoutTrailingSlash = value => value.replace(/\/+$/, '');

const fetchJson = async (fetchImpl, url) => {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
};

export const checkWalletBackend = async ({ endpoint, expectedNetwork, fetchImpl = fetch }) => {
  const baseUrl = withoutTrailingSlash(endpoint);
  const health = await fetchJson(fetchImpl, `${baseUrl}/health`);
  if (health?.status !== 'ok') throw new Error('wallet backend health response is not ok');

  const status = await fetchJson(fetchImpl, `${baseUrl}/v1/status`);
  if (status?.network !== expectedNetwork) {
    throw new Error(`wallet backend network is ${String(status?.network)}, expected ${expectedNetwork}`);
  }
  if (status?.chain !== 'ok' || status?.tip == null) {
    throw new Error(`wallet backend chain is ${String(status?.chain)}, expected ok with a tip`);
  }
  const remoteConfig = await fetchJson(fetchImpl, `${baseUrl}/v1/config`);
  if (remoteConfig == null || typeof remoteConfig !== 'object' || Array.isArray(remoteConfig)) {
    throw new Error('wallet backend remote config response is invalid');
  }
  return status;
};

export const waitForWalletBackend = async ({ endpoint, expectedNetwork, attempts = 30, delayMs = 2000, fetchImpl = fetch }) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await checkWalletBackend({ endpoint, expectedNetwork, fetchImpl });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`wallet backend did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

const main = async () => {
  const [endpoint, expectedNetwork] = process.argv.slice(2);
  if (!endpoint || !expectedNetwork) throw new Error('usage: walletBackendPreflight.mjs ENDPOINT EXPECTED_NETWORK');
  const status = await waitForWalletBackend({ endpoint, expectedNetwork });
  console.log(`wallet backend ready: ${status.network} via ${status.provider}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
