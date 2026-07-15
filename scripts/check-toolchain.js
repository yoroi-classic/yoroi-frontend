#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const PACKAGE_DIRS = ['.', 'packages/yoroi-extension', 'packages/e2e-tests'];
const EXPECTED_LOCKFILE_VERSION = 3;

const errors = [];

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

function addError(message) {
  errors.push(message);
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    addError(`${label} must be ${expected}, found ${actual || 'missing'}`);
  }
}

const rootPackage = readJson('package.json');
const expectedNodeVersion = readText('.nvmrc');
const expectedNodeRange = rootPackage.engines && rootPackage.engines.node;
const expectedNpmVersion = rootPackage.engines && rootPackage.engines.npm;
const expectedPackageManager = `npm@${expectedNpmVersion}`;
const actualNpmVersion = execFileSync('npm', ['--version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

expectEqual('active Node version', process.versions.node, expectedNodeVersion);
expectEqual('active npm version', actualNpmVersion, expectedNpmVersion);

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
  expectEqual(`${packageLabel} package-lock engines.node`, lockfileRoot.engines && lockfileRoot.engines.node, expectedNodeRange);
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
