const path = require('path');

const baseline = require('./typescript-eslint-baseline.json');
const configuredRuleIds = require('./typescript-eslint-baseline-rules');

process.env.YOROI_TYPESCRIPT_ESLINT_BASELINE = '1';
process.env.TSESTREE_SINGLE_RUN = 'false';

const { ESLint } = require('eslint');

const packageRoot = path.resolve(__dirname, '..');

function compareBaseline(expected, actual) {
  const growth = [];
  const decreases = [];

  for (const [ruleId, limit] of Object.entries(expected)) {
    const count = actual[ruleId] ?? 0;
    if (count > limit) growth.push({ ruleId, limit, count });
    if (count < limit) decreases.push({ ruleId, limit, count });
  }

  return { growth, decreases };
}

function compareRuleKeys(configured, expected) {
  const configuredKeys = new Set(configured);
  const expectedKeys = new Set(Object.keys(expected));
  return {
    duplicates: configured.filter((ruleId, index) => configured.indexOf(ruleId) !== index).sort(),
    missingFromBaseline: configured.filter(ruleId => !expectedKeys.has(ruleId)).sort(),
    missingFromConfig: [...expectedKeys].filter(ruleId => !configuredKeys.has(ruleId)).sort(),
  };
}

function classifyResults(results, expected) {
  const counts = Object.fromEntries(Object.keys(expected).map(ruleId => [ruleId, 0]));
  const unexpectedResults = [];

  for (const result of results) {
    const unexpectedMessages = [];
    for (const message of result.messages) {
      if (message.ruleId != null && Object.hasOwn(expected, message.ruleId)) {
        counts[message.ruleId] += 1;
      } else if (message.severity === 2) {
        unexpectedMessages.push(message);
      }
    }

    if (unexpectedMessages.length > 0) {
      unexpectedResults.push({
        ...result,
        errorCount: unexpectedMessages.length,
        fatalErrorCount: unexpectedMessages.filter(message => message.fatal === true).length,
        messages: unexpectedMessages,
        warningCount: 0,
      });
    }
  }

  return { counts, unexpectedResults };
}

async function main() {
  const keyMismatch = compareRuleKeys(configuredRuleIds, baseline);
  if (Object.values(keyMismatch).some(entries => entries.length > 0)) {
    throw new Error(`TypeScript ESLint baseline/config key mismatch: ${JSON.stringify(keyMismatch)}`);
  }

  const eslint = new ESLint({ cwd: packageRoot });
  const results = await eslint.lintFiles(['**/*.{js,jsx,ts,tsx,mjs,cjs}']);
  const { counts, unexpectedResults } = classifyResults(results, baseline);
  const { growth, decreases } = compareBaseline(baseline, counts);

  console.log('TypeScript ESLint baseline:');
  for (const [ruleId, limit] of Object.entries(baseline)) {
    const marker = counts[ruleId] < limit ? ' (decreased; lower the reviewed baseline intentionally)' : '';
    console.log(`- ${ruleId}: ${counts[ruleId]}/${limit}${marker}`);
  }

  if (unexpectedResults.length > 0) {
    const formatter = await eslint.loadFormatter('stylish');
    console.error('\nUnbaselined ESLint errors:');
    console.error(await formatter.format(unexpectedResults));
  }

  if (growth.length > 0) {
    console.error('\nTypeScript ESLint baseline growth:');
    for (const { ruleId, limit, count } of growth) console.error(`- ${ruleId}: ${count} exceeds ${limit}`);
  }

  if (decreases.length > 0) {
    console.log(`\n${decreases.length} baseline rule count(s) decreased; update the JSON ceiling in a reviewed change.`);
  }

  if (unexpectedResults.length > 0 || growth.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  classifyResults,
  compareBaseline,
  compareRuleKeys,
};
