#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const ACTIONS = Object.freeze({
  'actions/checkout': Object.freeze({
    sha: '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    version: 'v7.0.0',
    count: 16,
  }),
  'actions/setup-node': Object.freeze({
    sha: '820762786026740c76f36085b0efc47a31fe5020',
    version: 'v7.0.0',
    count: 11,
  }),
  'actions/cache': Object.freeze({
    sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
    version: 'v6.1.0',
    count: 9,
  }),
  'actions/upload-artifact': Object.freeze({
    sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    version: 'v7.0.1',
    count: 9,
  }),
  'actions/download-artifact': Object.freeze({
    sha: '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    version: 'v8.0.1',
    count: 4,
  }),
  'actions/dependency-review-action': Object.freeze({
    sha: '2031cfc080254a8a887f58cffee85186f0e49e48',
    version: 'v4.9.0',
    count: 1,
  }),
  'browser-actions/release-chrome-extension': Object.freeze({
    sha: 'bde2f9ad09b20a52d4e71eca4a9daf99d412a8d9',
    version: 'v0.2.1',
    count: 1,
  }),
  'browser-actions/setup-chrome': Object.freeze({
    sha: '2e1d749697dd1612b833dba4a722266286fbefcd',
    version: 'v2.1.2',
    count: 4,
  }),
  'OctopusDeploy/install-octopus-cli-action': Object.freeze({
    sha: 'c635bb83aa1afb643e7132a1887aa517a9739fb0',
    version: 'v3.1.4',
    count: 1,
  }),
  'OctopusDeploy/push-package-action': Object.freeze({
    sha: 'e2050621dbc1f83e223b6a5ca7ff2ec3dd6809e8',
    version: 'v3.2.5',
    count: 1,
  }),
  'OctopusDeploy/create-release-action': Object.freeze({
    sha: '1c58525ed52e1af84afa68eb495486a52661d6da',
    version: 'v3.3.0',
    count: 1,
  }),
  'peter-evans/create-pull-request': Object.freeze({
    sha: '271a8d0340265f705b14b6d32b9829c1cb33d45e',
    version: 'v7.0.8',
    count: 1,
  }),
  'sonarsource/sonarqube-scan-action': Object.freeze({
    sha: '713881670b6b3676cda39549040e2d88c70d582e',
    version: 'v8.2.0',
    count: 1,
  }),
});

const TARGET_USE = /^\s*(?:-\s+)?uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)(?:\s+#\s*(\S+))?\s*$/;
const LOCAL_USE = /^\s*(?:-\s+)?uses:\s*\.\/\S+(?:\s+#.*)?$/;
const NVMRC_NODE_VERSION = /node-version:\s*['"]?\$\{\{\s*steps\.nvm\.outputs\.NVMRC\s*\}\}['"]?/;
const CHROME_PUBLISH_INPUTS = Object.freeze([
  /extension-id:\s*['"]poonlenmfdfbjfeeballhiibknlknepo['"]/,
  /extension-path:\s*['"]\.\/packages\/yoroi-extension\/Yoroi Nightly\.zip['"]/,
  /oauth-client-id:\s*\$\{\{\s*secrets\.NIGHTLY_CLIENT_ID\s*\}\}/,
  /oauth-client-secret:\s*\$\{\{\s*secrets\.NIGHTLY_CLIENT_SECRET\s*\}\}/,
  /oauth-refresh-token:\s*\$\{\{\s*secrets\.NIGHTLY_TOKEN\s*\}\}/,
]);

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
      if (!line.includes('uses:')) return;
      const match = TARGET_USE.exec(line);
      if (match == null) {
        if (!LOCAL_USE.test(line)) errors.push(`${relativeFile}:${index + 1} has an invalid action reference`);
        return;
      }

      const [, action, ref, versionComment] = match;
      const expected = ACTIONS[action];
      if (expected == null) {
        errors.push(`${relativeFile}:${index + 1} uses unreviewed external action ${action}`);
        return;
      }
      inventory[action] += 1;

      if (!/^[0-9a-f]{40}$/.test(ref)) {
        errors.push(`${relativeFile}:${index + 1} ${action} must use a full 40-character commit SHA`);
      } else if (ref !== expected.sha) {
        errors.push(`${relativeFile}:${index + 1} ${action} must pin ${expected.sha}`);
      }
      if (versionComment !== expected.version) {
        errors.push(`${relativeFile}:${index + 1} ${action} must have comment # ${expected.version}`);
      }

      if (action === 'actions/setup-node') {
        const setupBlock = lines.slice(index + 1, index + 8).join('\n');
        if (!NVMRC_NODE_VERSION.test(setupBlock)) {
          errors.push(`${relativeFile}:${index + 1} ${action} must install the version read from .nvmrc`);
        }
      }

      if (action === 'browser-actions/release-chrome-extension') {
        const publishBlock = lines.slice(index + 1, index + 9).join('\n');
        if (CHROME_PUBLISH_INPUTS.some(pattern => !pattern.test(publishBlock))) {
          errors.push(`${relativeFile}:${index + 1} Chrome publication inputs must preserve the nightly release contract`);
        }
      }
    });
  }

  for (const [action, expected] of Object.entries(ACTIONS)) {
    if (inventory[action] !== expected.count) {
      errors.push(`${action} inventory must contain ${expected.count} uses, found ${inventory[action]}`);
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
  console.log(`Workflow action contract OK: ${total} immutable external action references`);
}

if (require.main === module) run();

module.exports = {
  ACTIONS,
  auditWorkflows,
};
