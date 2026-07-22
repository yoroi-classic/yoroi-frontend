# Reviewing Yoroi

Hello, and thank you for reviewing Yoroi for your platform!

### Finding version commit you're testing

You should be able to find the exact release you're reviewing in the
[yoroi-classic release list](https://github.com/yoroi-classic/yoroi-frontend/releases).

If you want to know the exact version & commit used for the build you've received, you can find it inside the settings page.

![image](https://user-images.githubusercontent.com/2608559/84115683-6d48d880-aa69-11ea-92b3-f36954f1227f.png)

### How to do I get an account for review purposes?

Yoroi connects to network(s) called "blockchains". These blockchains are decentralized networks that we have no control over. Wallets are just a way for users to easily view and manage assets their own on the network. That means there is no way to "credit" a tester account for you.

You can:

- create or restore a wallet on our software (does not require any money or personal information. All generated data never leaves your computer)

- ask us to send you a small amount of funds / share with you a wallet with a small amount of funds to test with (again, these are real assets on the network so we cannot easily share any non-trivial amount). Although even this only gives you limited access because we cannot send you all possible combinations, nor can we physically send you "hardware wallets".

We cannot:

- generate any "god-mode" or unlimited fund account for you to test with

### Building the code

Make sure you checked out the exact commit for the version you're testing. Keep in mind builds may differ slightly in the following way:

1) Information like commit number, branch name, etc. are stored inside builds.
1) Some tooling like nodejs's buffer library saves your user path inside the build information (ex: `C:/github/yoroi`)

However, overall the build should match exactly.

#### Setting it up on your machine (recommended)

If you want to build the code on your machine, you should be able to follow the regular project setup and build steps outlined in the repository's main readme.

#### Reproducing the CI build locally

The repository currently supports Node.js 22.22.2 and npm 10.9.7. After
checking out the exact release commit, use the checked-in toolchain and clean
install path rather than an unpinned global environment:

```bash
# Go to the exact commit released to the browser stores.
git checkout insert-commit-or-version-number-here

# From the repository root, activate and verify the supported toolchain.
nvm use
corepack enable npm
corepack prepare npm@10.9.7 --activate
npm run check:toolchain

# Reproduce CI's clean dependency installation.
./ci-install-all.sh

# Build the extension without packaging it with a production signing key.
cd packages/yoroi-extension
npm run prod:build -- --env mainnet
```

See [SETUP.md](./SETUP.md), [BUILD.md](./BUILD.md), and [TEST.md](./TEST.md)
for the maintained setup, build, and verification commands.

### Other FAQ

**Q**: Who can use the hardware wallet? Is it accessible to every user? What are the requirements to be able to use it? \
**A**: Hardware wallets are sold by independent companies -- Satoshi Labs (Trezor) and Ledger (Ledger device). Their products are not just for Yoroi, but work for cryptocurrency wallets in general as long as they provide the integration. They're meant to increase the security of the user by managing their private key inside a physical device instead of on a computer

**Q**: Why does Yoroi make requests to a remote endpoint like "history" and "filterUsed" \
**A**: Yoroi is what you call a "light" (or sometimes "lite") wallet -- that means that instead of storing the entire blockchain, it queries a server for your account balance. We have an article that gives an overview of the security features of Yoroi here: https://medium.com/emurgo-announcement/yoroi-wallet-security-a42aafa79525
As I mentioned previously, all transaction history in the blockchain is publicly visible. Our extensions just fetches the subset of this data relevant to them through this remote endpoint.
