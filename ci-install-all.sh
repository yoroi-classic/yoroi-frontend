#!/usr/bin/env sh

set -eu

npm ci --legacy-peer-deps
npm ci --legacy-peer-deps --prefix packages/yoroi-extension
npm ci --prefix packages/e2e-tests
