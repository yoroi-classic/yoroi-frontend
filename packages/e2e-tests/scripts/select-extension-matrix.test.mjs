import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fullExtensionSuites,
  publicExtensionSuites,
  selectExtensionMatrix,
  writeGithubSelection,
} from './select-extension-matrix.mjs';

const suitesFrom = selection => selection.matrix.include.map(({ suite }) => suite);

test('selects only the public suite for a Dependabot review event', () => {
  const selection = selectExtensionMatrix({
    eventName: 'pull_request_review',
    pullRequestAuthor: 'dependabot[bot]',
  });

  assert.equal(selection.dependabotReview, true);
  assert.deepEqual(suitesFrom(selection), publicExtensionSuites);
});

test('keeps the full matrix for a trusted review event', () => {
  const selection = selectExtensionMatrix({
    eventName: 'pull_request_review',
    pullRequestAuthor: 'wallet-maintainer',
  });

  assert.equal(selection.dependabotReview, false);
  assert.deepEqual(suitesFrom(selection), fullExtensionSuites);
});

test('keeps the full matrix for a manual run', () => {
  const selection = selectExtensionMatrix({
    eventName: 'workflow_dispatch',
    pullRequestAuthor: '',
  });

  assert.equal(selection.dependabotReview, false);
  assert.deepEqual(suitesFrom(selection), fullExtensionSuites);
});

test('writes explicit Dependabot coverage evidence and a valid matrix output', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'yoroi-extension-matrix-'));
  const outputPath = path.join(directory, 'output');
  const summaryPath = path.join(directory, 'summary');

  try {
    const selection = selectExtensionMatrix({
      eventName: 'pull_request_review',
      pullRequestAuthor: 'dependabot[bot]',
    });
    writeGithubSelection(selection, { outputPath, summaryPath });

    const output = readFileSync(outputPath, 'utf8');
    const summary = readFileSync(summaryPath, 'utf8');
    assert.deepEqual(JSON.parse(output.match(/^matrix=(.+)$/m)[1]), selection.matrix);
    assert.match(summary, /protected wallet fixtures are unavailable/);
    assert.match(summary, /public NFT suite is the only extension suite selected/);
    assert.match(summary, /full nine-suite matrix/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
