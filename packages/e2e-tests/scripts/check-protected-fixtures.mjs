import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const protectedFixtureNames = Object.freeze([
  'FIRST_SMOKE_TEST_WALLET',
  'TEST_WALLET_MAINNET_1',
  'SECOND_STATIC_TEST_WALLET',
  'SECOND_SMOKE_TEST_WALLET',
]);

export const fullExtensionMatrix = Object.freeze({
  include: [
    { suite: 'cashback' },
    { suite: 'general' },
    { suite: 'governance' },
    { suite: 'nft' },
    { suite: 'portfolio' },
    { suite: 'receive' },
    { suite: 'send' },
    { suite: 'settings' },
    { suite: 'transactions' },
  ],
});

export const publicExtensionMatrix = Object.freeze({ include: [{ suite: 'nft' }] });

export function protectedFixtureReport(env) {
  const missing = protectedFixtureNames.filter(name => String(env[name] ?? '').trim() === '');
  return {
    available: missing.length === 0,
    matrix: missing.length === 0 ? fullExtensionMatrix : publicExtensionMatrix,
    missing,
  };
}

export function writeGithubReport(report, { outputPath, summaryPath }) {
  if (outputPath) {
    appendFileSync(outputPath, `available=${String(report.available)}\n`);
    appendFileSync(outputPath, `matrix=${JSON.stringify(report.matrix)}\n`);
  }

  if (summaryPath) {
    const status = report.available ? 'available' : 'unavailable';
    appendFileSync(summaryPath, `## Protected wallet fixtures: ${status}\n\n`);
    if (report.available) {
      appendFileSync(summaryPath, 'All protected extension suites will run.\n');
    } else {
      appendFileSync(summaryPath, `Missing repository secrets: ${report.missing.map(name => `\`${name}\``).join(', ')}.\n\n`);
      appendFileSync(
        summaryPath,
        'Secret-backed extension suites will not start. The NFT suite uses a public compromised fixture and will still run.\n'
      );
    }
  }
}

function main() {
  const report = protectedFixtureReport(process.env);
  writeGithubReport(report, {
    outputPath: process.env.GITHUB_OUTPUT,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  });

  if (!report.available) {
    console.error(`Missing protected wallet fixtures: ${report.missing.join(', ')}`);
    if (!process.argv.includes('--report-only')) process.exitCode = 1;
  } else {
    console.log('Protected wallet fixtures are available');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
