import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fullExtensionMatrix,
  protectedFixtureNames,
  protectedFixtureReport,
  publicExtensionMatrix,
  writeGithubReport,
} from './check-protected-fixtures.mjs';

const completeEnvironment = Object.fromEntries(protectedFixtureNames.map(name => [name, `${name}-value`]));

test('runs the complete extension matrix when every protected fixture is present', () => {
  assert.deepEqual(protectedFixtureReport(completeEnvironment), {
    available: true,
    matrix: fullExtensionMatrix,
    missing: [],
  });
});

test('runs only the public fixture suite when protected fixtures are missing', () => {
  const environment = { ...completeEnvironment, FIRST_SMOKE_TEST_WALLET: '', SECOND_STATIC_TEST_WALLET: '  ' };
  assert.deepEqual(protectedFixtureReport(environment), {
    available: false,
    matrix: publicExtensionMatrix,
    missing: ['FIRST_SMOKE_TEST_WALLET', 'SECOND_STATIC_TEST_WALLET'],
  });
});

test('writes GitHub outputs and a summary without exposing fixture contents', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'yoroi-e2e-fixtures-'));
  const outputPath = path.join(directory, 'output');
  const summaryPath = path.join(directory, 'summary');

  try {
    const report = protectedFixtureReport(completeEnvironment);
    writeGithubReport(report, { outputPath, summaryPath });

    const output = readFileSync(outputPath, 'utf8');
    const summary = readFileSync(summaryPath, 'utf8');
    assert.match(output, /^available=true$/m);
    assert.deepEqual(JSON.parse(output.match(/^matrix=(.+)$/m)[1]), fullExtensionMatrix);
    assert.match(summary, /Protected wallet fixtures: available/);
    for (const value of Object.values(completeEnvironment)) assert.doesNotMatch(summary, new RegExp(value));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
