#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const ACTIONS = Object.freeze({
  checkout: Object.freeze({
    sha: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    version: 'v7.0.0',
    count: 16,
  }),
  'setup-node': Object.freeze({
    sha: '820762786026740c76f36085b0efc47a31fe5020',
    version: 'v7.0.0',
    count: 11,
  }),
  cache: Object.freeze({
    sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
    version: 'v6.1.0',
    count: 2,
  }),
  'upload-artifact': Object.freeze({
    sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    version: 'v7.0.1',
    count: 9,
  }),
  'download-artifact': Object.freeze({
    sha: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    version: 'v8.0.1',
    count: 4,
  }),
});

const TARGET_USE =
  /^\s*(?:-\s+)?uses:\s*actions\/(checkout|setup-node|cache|upload-artifact|download-artifact)@([^\s#]+)(?:\s+#\s*(\S+))?\s*$/;
const NVMRC_NODE_VERSION = /node-version:\s*['"]?\$\{\{\s*steps\.nvm\.outputs\.NVMRC\s*\}\}['"]?/;

function workflowFiles(root = WORKSPACE_ROOT) {
  const workflowDir = path.join(root, '.github', 'workflows');
  return fs
    .readdirSync(workflowDir)
    .filter(file => /\.ya?ml$/.test(file))
    .sort()
    .map(file => path.join(workflowDir, file));
}

function auditWorkflows({ root = WORKSPACE_ROOT } = {}) {
  const errors = [];
  const inventory = Object.fromEntries(Object.keys(ACTIONS).map(action => [action, 0]));

  for (const file of workflowFiles(root)) {
    const relativeFile = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

    lines.forEach((line, index) => {
      if (!line.includes('uses: actions/')) return;
      const match = TARGET_USE.exec(line);
      if (match == null) {
        if (/actions\/(checkout|setup-node|cache|upload-artifact|download-artifact)@/.test(line)) {
          errors.push(`${relativeFile}:${index + 1} has an invalid official action reference`);
        }
        return;
      }

      const [, action, ref, versionComment] = match;
      const expected = ACTIONS[action];
      inventory[action] += 1;

      if (!/^[0-9a-f]{40}$/.test(ref)) {
        errors.push(`${relativeFile}:${index + 1} actions/${action} must use a full 40-character commit SHA`);
      } else if (ref !== expected.sha) {
        errors.push(`${relativeFile}:${index + 1} actions/${action} must pin ${expected.sha}`);
      }
      if (versionComment !== expected.version) {
        errors.push(`${relativeFile}:${index + 1} actions/${action} must have comment # ${expected.version}`);
      }

      if (action === 'setup-node') {
        const setupBlock = lines.slice(index + 1, index + 8).join('\n');
        if (!NVMRC_NODE_VERSION.test(setupBlock)) {
          errors.push(`${relativeFile}:${index + 1} actions/setup-node must install the version read from .nvmrc`);
        }
      }
    });
  }

  for (const [action, expected] of Object.entries(ACTIONS)) {
    if (inventory[action] !== expected.count) {
      errors.push(`actions/${action} inventory must contain ${expected.count} uses, found ${inventory[action]}`);
    }
  }

  return { errors, inventory };
}

function run() {
  const { errors, inventory } = auditWorkflows();
  if (errors.length > 0) {
    console.error('Workflow action contract failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  const total = Object.values(inventory).reduce((sum, count) => sum + count, 0);
  console.log(`Workflow action contract OK: ${total} immutable official action references`);
}

if (require.main === module) run();

module.exports = {
  ACTIONS,
  auditWorkflows,
};
