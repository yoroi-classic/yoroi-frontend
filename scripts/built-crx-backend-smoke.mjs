#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const command = async (webdriverUrl, path, { method = 'POST', body } = {}) => {
  const response = await fetch(`${webdriverUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result.value ?? result));
  return result.value;
};

export const validateSmokeResult = ({ result, backendOrigin, expectedNetwork }) => {
  if (result?.smokeError) throw new Error(result.smokeError);
  if (!result?.hostPermissions?.includes(`${backendOrigin}/*`)) {
    throw new Error(`signed CRX manifest does not permit ${backendOrigin}/*`);
  }
  if (!result?.contentSecurityPolicy?.includes(backendOrigin)) {
    throw new Error(`signed CRX content security policy does not permit ${backendOrigin}`);
  }
  if (result?.status?.httpStatus !== 200 || result?.tip?.httpStatus !== 200) {
    throw new Error(`wallet backend request failed: ${JSON.stringify({ status: result?.status, tip: result?.tip })}`);
  }
  if (result.status.body?.network !== expectedNetwork) {
    throw new Error(`wallet backend network is ${String(result.status.body?.network)}, expected ${expectedNetwork}`);
  }
  if (result.status.body?.chain !== 'ok' || result.status.body?.tip == null) {
    throw new Error(`wallet backend chain is ${String(result.status.body?.chain)}, expected ok with a tip`);
  }
  if (result.tip.body == null || typeof result.tip.body !== 'object' || Array.isArray(result.tip.body)) {
    throw new Error('wallet backend chain tip response is invalid');
  }
};

const waitForWebdriver = async webdriverUrl => {
  let lastError;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(`${webdriverUrl}/status`, { signal: AbortSignal.timeout(2000) });
      const status = await response.json();
      if (response.ok && status.value?.ready === true) return;
      lastError = new Error('WebDriver is not ready');
    } catch (error) {
      lastError = error;
    }
    if (attempt < 30) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`WebDriver did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

export const runSmoke = async ({ crxPath, webdriverUrl, backendOrigin, expectedNetwork }) => {
  await waitForWebdriver(webdriverUrl);
  const extension = readFileSync(crxPath).toString('base64');
  const session = await command(webdriverUrl, '/session', {
    body: {
      capabilities: {
        alwaysMatch: {
          browserName: 'chrome',
          'goog:chromeOptions': {
            args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
            extensions: [extension],
          },
        },
      },
    },
  });

  const sessionId = session.sessionId;
  try {
    const targets = await command(webdriverUrl, `/session/${sessionId}/goog/cdp/execute`, {
      body: { cmd: 'Target.getTargets', params: {} },
    });
    const serviceWorker = targets.targetInfos.find(
      ({ type, url }) => type === 'service_worker' && url.startsWith('chrome-extension://')
    );
    if (!serviceWorker) throw new Error('Yoroi extension service worker was not loaded');

    const extensionOrigin = new URL(serviceWorker.url).origin;
    const extensionTarget = await command(webdriverUrl, `/session/${sessionId}/goog/cdp/execute`, {
      body: { cmd: 'Target.createTarget', params: { url: `${extensionOrigin}/manifest.json` } },
    });
    await command(webdriverUrl, `/session/${sessionId}/window`, {
      body: { handle: extensionTarget.targetId },
    });
    const result = await command(webdriverUrl, `/session/${sessionId}/execute/async`, {
      body: {
        script: `
          const done = arguments[arguments.length - 1];
          const fetchJson = async path => {
            const response = await fetch(${JSON.stringify(backendOrigin)} + path);
            return { httpStatus: response.status, body: await response.json() };
          };
          Promise.all([fetchJson('/v1/status'), fetchJson('/v1/chain/tip')])
            .then(([status, tip]) => {
              const manifest = chrome.runtime.getManifest();
              done({
                hostPermissions: manifest.host_permissions ?? [],
                contentSecurityPolicy: manifest.content_security_policy?.extension_pages ?? '',
                status,
                tip,
              });
            }, error => done({ smokeError: String(error) }));
        `,
        args: [],
      },
    });
    validateSmokeResult({ result, backendOrigin, expectedNetwork });
    console.log(`built CRX reached ${expectedNetwork} cardano-wallet-backend through ${backendOrigin}`);
  } finally {
    await command(webdriverUrl, `/session/${sessionId}`, { method: 'DELETE' });
  }
};

const main = async () => {
  const [crxPath, expectedNetwork, webdriverUrl = 'http://127.0.0.1:4444', backendOrigin = 'http://wallet-backend:3010'] =
    process.argv.slice(2);
  if (!crxPath || !['mainnet', 'preprod'].includes(expectedNetwork)) {
    throw new Error('usage: built-crx-backend-smoke.mjs CRX_PATH <mainnet|preprod> [WEBDRIVER_URL] [BACKEND_ORIGIN]');
  }
  await runSmoke({ crxPath, webdriverUrl, backendOrigin, expectedNetwork });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
