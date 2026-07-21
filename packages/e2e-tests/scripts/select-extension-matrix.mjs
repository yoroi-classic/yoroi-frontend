import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const fullExtensionSuites = Object.freeze([
  'cashback',
  'general',
  'governance',
  'nft',
  'portfolio',
  'receive',
  'send',
  'settings',
  'transactions',
]);

export const publicExtensionSuites = Object.freeze(['nft']);

export function selectExtensionMatrix({ eventName, pullRequestAuthor }) {
  const dependabotReview = eventName === 'pull_request_review' && pullRequestAuthor === 'dependabot[bot]';
  const suites = dependabotReview ? publicExtensionSuites : fullExtensionSuites;

  return {
    dependabotReview,
    matrix: { include: suites.map(suite => ({ suite })) },
  };
}

export function writeGithubSelection(selection, { outputPath, summaryPath }) {
  if (outputPath) appendFileSync(outputPath, `matrix=${JSON.stringify(selection.matrix)}\n`);

  if (summaryPath) {
    appendFileSync(summaryPath, '## Extension E2E coverage\n\n');
    if (selection.dependabotReview) {
      appendFileSync(
        summaryPath,
        'Dependabot review event: protected wallet fixtures are unavailable, so the public NFT suite is the only extension suite selected. Trusted review and manual runs retain the full nine-suite matrix.\n'
      );
    } else {
      appendFileSync(summaryPath, 'Trusted review or manual event: all nine extension suites are selected.\n');
    }
  }
}

function main() {
  const selection = selectExtensionMatrix({
    eventName: process.env.EVENT_NAME ?? '',
    pullRequestAuthor: process.env.PULL_REQUEST_AUTHOR ?? '',
  });
  writeGithubSelection(selection, {
    outputPath: process.env.GITHUB_OUTPUT,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  });

  if (selection.dependabotReview) {
    console.log(
      '::notice title=Extension E2E coverage::Protected-wallet suites are unavailable for Dependabot; running the public NFT suite only.'
    );
  } else {
    console.log('All extension E2E suites selected');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
