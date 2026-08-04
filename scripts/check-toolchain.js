#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const PACKAGE_DIRS = ['.', 'packages/yoroi-extension', 'packages/e2e-tests'];
const EXPECTED_LOCKFILE_VERSION = 3;

function workspacePath(relativePath) {
  return path.join(WORKSPACE_ROOT, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(workspacePath(relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(workspacePath(relativePath), 'utf8').trim();
}

function labelForPackage(packageDir) {
  return packageDir === '.' ? 'root package' : `${packageDir} package`;
}

function formatCommandFailure(error) {
  const details = [];
  if (typeof error.status === 'number') {
    details.push(`exit status ${error.status}`);
  }
  if (error.signal) {
    details.push(`signal ${error.signal}`);
  }
  const stderr = String(error.stderr || '').trim();
  if (stderr !== '') {
    details.push(`stderr: ${stderr}`);
  }

  return details.length > 0 ? details.join('; ') : error.message;
}

function parseNpmVersionFromUserAgent(userAgent) {
  const match = /^npm\/([^\s]+)/.exec(userAgent || '');
  return match ? match[1] : null;
}

function parseNpmConfig(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#') && !line.startsWith(';'))
      .map(line => {
        const separator = line.indexOf('=');
        return separator === -1 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
  );
}

function detectNpmVersion(options = {}) {
  const runCommand = typeof options === 'function' ? options : options.runCommand || execFileSync;
  const env = typeof options === 'function' ? process.env : options.env || process.env;
  let commandError = null;

  try {
    const output = String(
      runCommand('npm', ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).trim();

    if (output === '') {
      commandError = '`npm --version` produced no output';
    } else {
      return { version: output, error: null };
    }
  } catch (error) {
    commandError = `\`npm --version\` failed: ${formatCommandFailure(error)}`;
  }

  const userAgentVersion = parseNpmVersionFromUserAgent(env.npm_config_user_agent);
  if (userAgentVersion) {
    return { version: userAgentVersion, error: null };
  }

  return { version: null, error: commandError };
}

function run() {
  const errors = [];
  const addError = message => errors.push(message);
  const expectEqual = (label, actual, expected) => {
    if (actual !== expected) {
      addError(`${label} must be ${expected}, found ${actual || 'missing'}`);
    }
  };

  const rootPackage = readJson('package.json');
  const expectedNodeVersion = readText('.nvmrc');
  const expectedNodeRange = rootPackage.engines && rootPackage.engines.node;
  const expectedNpmVersion = rootPackage.engines && rootPackage.engines.npm;
  const expectedPackageManager = `npm@${expectedNpmVersion}`;
  const actualNpmVersion = detectNpmVersion();
  const npmConfig = parseNpmConfig(readText('.npmrc'));

  expectEqual('active Node version', process.versions.node, expectedNodeVersion);
  if (actualNpmVersion.error) {
    addError(`active npm version could not be detected: ${actualNpmVersion.error}`);
  } else {
    expectEqual('active npm version', actualNpmVersion.version, expectedNpmVersion);
  }
  expectEqual('root .npmrc engine-strict', npmConfig['engine-strict'], 'true');
  expectEqual('root .npmrc legacy-peer-deps', npmConfig['legacy-peer-deps'], 'true');

  for (const packageDir of PACKAGE_DIRS) {
    const packageLabel = labelForPackage(packageDir);
    const packageJsonPath = path.join(packageDir, 'package.json');
    const packageJson = readJson(packageJsonPath);

    expectEqual(`${packageLabel} packageManager`, packageJson.packageManager, expectedPackageManager);
    expectEqual(`${packageLabel} engines.node`, packageJson.engines && packageJson.engines.node, expectedNodeRange);
    expectEqual(`${packageLabel} engines.npm`, packageJson.engines && packageJson.engines.npm, expectedNpmVersion);

    const lockfilePath = path.join(packageDir, 'package-lock.json');
    const lockfile = readJson(lockfilePath);
    const lockfileRoot = lockfile.packages && lockfile.packages[''];

    expectEqual(`${packageLabel} package-lock lockfileVersion`, lockfile.lockfileVersion, EXPECTED_LOCKFILE_VERSION);

    if (lockfileRoot == null) {
      addError(`${packageLabel} package-lock root entry is missing`);
      continue;
    }

    expectEqual(`${packageLabel} package-lock root name`, lockfileRoot.name, packageJson.name);
    expectEqual(
      `${packageLabel} package-lock engines.node`,
      lockfileRoot.engines && lockfileRoot.engines.node,
      expectedNodeRange
    );
    expectEqual(`${packageLabel} package-lock engines.npm`, lockfileRoot.engines && lockfileRoot.engines.npm, expectedNpmVersion);
  }

  if (errors.length > 0) {
    console.error('Toolchain baseline check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Toolchain baseline OK: Node ${expectedNodeVersion}, npm ${expectedNpmVersion}`);
}

if (require.main === module) {
  run();
}

module.exports = {
  detectNpmVersion,
  formatCommandFailure,
  parseNpmConfig,
  parseNpmVersionFromUserAgent,
};
