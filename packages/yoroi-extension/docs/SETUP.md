# Environment

The repository currently supports Node.js 22.22.2 and npm 10.9.7. The
authoritative versions are checked in at the repository root in `.nvmrc` and
the `packageManager` and `engines` fields of `package.json`.

GitHub Actions runs the extension checks on Ubuntu 24.04. Other development
platforms should use the same Node.js and npm versions.

# Prerequisites

From the repository root, select the checked-in Node.js version and activate
the supported npm release:

```bash
nvm use
corepack enable npm
corepack prepare npm@10.9.7 --activate
npm run check:toolchain
```

If the Node.js version is not installed yet, run `nvm install` before
`nvm use`.

## Packages

Use the repository's clean-install script from the repository root. It applies
the lockfile and peer-dependency settings required by each package:

```bash
./ci-install-all.sh
```

CI uses clean lockfile installs so local dependency resolution matches the
checked-in state. Do not use an install command that re-resolves and rewrites
dependencies.

## Generating PEMs

To package signed production versions of Yoroi, you need a PEM key. Production
keys are not stored in GitHub. For local testing, generate a disposable key
from `packages/yoroi-extension`:

```bash
npm run keygen
mv key.pem pem_name_here.pem
```

The packaging script identifies the expected key filename for each build type.
Never commit generated or production signing keys.
