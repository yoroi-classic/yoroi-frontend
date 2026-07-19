const assert = require('node:assert/strict');
const test = require('node:test');

// Kept outside Jest's *.test.js discovery; this contract uses Node's test runner.

const baseline = require('./typescript-eslint-baseline.json');
const configuredRuleIds = require('./typescript-eslint-baseline-rules');
const { classifyResults, compareBaseline, compareRuleKeys } = require('./check-typescript-eslint-baseline');

const EXPECTED_RULE_IDS = [
  '@typescript-eslint/ban-ts-comment',
  '@typescript-eslint/no-empty-object-type',
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
  '@typescript-eslint/no-redundant-type-constituents',
  '@typescript-eslint/no-this-alias',
  '@typescript-eslint/no-unnecessary-type-assertion',
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-enum-comparison',
  '@typescript-eslint/no-unsafe-function-type',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-return',
  '@typescript-eslint/no-unused-expressions',
  '@typescript-eslint/no-wrapper-object-types',
  '@typescript-eslint/only-throw-error',
  '@typescript-eslint/prefer-promise-reject-errors',
  '@typescript-eslint/require-await',
  '@typescript-eslint/restrict-template-expressions',
  '@typescript-eslint/unbound-method',
];

test('locks the exact authoritative 22-rule baseline inventory', () => {
  assert.deepEqual(configuredRuleIds, EXPECTED_RULE_IDS);
  assert.deepEqual(Object.keys(baseline), EXPECTED_RULE_IDS);
  assert.equal(
    Object.values(baseline).reduce((sum, count) => sum + count, 0),
    4785
  );
});

test('rejects per-rule baseline growth', () => {
  const result = compareBaseline({ 'rule/a': 2, 'rule/b': 4 }, { 'rule/a': 3, 'rule/b': 4 });
  assert.deepEqual(result.growth, [{ ruleId: 'rule/a', limit: 2, count: 3 }]);
  assert.deepEqual(result.decreases, []);
});

test('accepts per-rule baseline decreases without rewriting the ceiling', () => {
  const expected = { 'rule/a': 2, 'rule/b': 4 };
  const result = compareBaseline(expected, { 'rule/a': 1, 'rule/b': 4 });
  assert.deepEqual(result.growth, []);
  assert.deepEqual(result.decreases, [{ ruleId: 'rule/a', limit: 2, count: 1 }]);
  assert.deepEqual(expected, { 'rule/a': 2, 'rule/b': 4 });
});

test('keeps tracked debt separate while preserving untracked errors', () => {
  const result = classifyResults(
    [
      {
        errorCount: 1,
        fatalErrorCount: 0,
        filePath: 'fixture.ts',
        messages: [
          { ruleId: 'rule/tracked', severity: 1 },
          { ruleId: 'rule/untracked', severity: 2 },
          { fatal: true, ruleId: null, severity: 2 },
          { ruleId: 'rule/warning', severity: 1 },
        ],
        warningCount: 2,
      },
    ],
    { 'rule/tracked': 1 }
  );
  assert.deepEqual(result.counts, { 'rule/tracked': 1 });
  assert.deepEqual(result.unexpectedResults[0].messages, [
    { ruleId: 'rule/untracked', severity: 2 },
    { fatal: true, ruleId: null, severity: 2 },
  ]);
  assert.equal(result.unexpectedResults[0].fatalErrorCount, 1);
});

test('rejects baseline and configured-rule key drift', () => {
  assert.deepEqual(compareRuleKeys(['rule/a', 'rule/new'], { 'rule/a': 1, 'rule/removed': 2 }), {
    duplicates: [],
    missingFromBaseline: ['rule/new'],
    missingFromConfig: ['rule/removed'],
  });
});
