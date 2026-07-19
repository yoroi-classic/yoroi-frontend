(() => {
  const MAX_CIP103_TXS = 20;
  const API_INVALID_REQUEST = -1;

  class CardanoAuth {
    constructor(auth, rpc) {
      this._auth = auth;
      this._cardano_rpc_call = rpc;
    }

    isEnabled() {
      return this._auth != null;
    }

    getWalletId() {
      if (!this._auth) {
        throw new Error('This connection does not have auth enabled!');
      }
      return this._auth.walletId;
    }

    getWalletPubkey() {
      if (!this._auth) {
        throw new Error('This connection does not have auth enabled!');
      }
      return this._auth.pubkey;
    }

    signHexPayload(payload_hex_string) {
      if (!this._auth) {
        throw new Error('This connection does not have auth enabled!');
      }
      return this._cardano_rpc_call('auth_sign_hex_payload/cardano', [payload_hex_string]);
    }

    checkHexPayload(payload_hex_string, signature_hex_string) {
      if (!this._auth) {
        throw new Error('This connection does not have auth enabled!');
      }
      return this._cardano_rpc_call('auth_check_hex_payload/cardano', [payload_hex_string, signature_hex_string]);
    }
  }
  class CardanoAPI {
    constructor(auth, rpc) {
      function rpcWrapper(func, params) {
        return rpc(func, params, CardanoAPI._returnType[0]);
      }
      function cborRpcWrapper(func, params) {
        return rpc(func, params, 'cbor');
      }
      CardanoAPI._auth = new CardanoAuth(auth, rpcWrapper);
      CardanoAPI._cardano_rpc_call = rpcWrapper;
      CardanoAPI._cardano_rpc_cbor_call = cborRpcWrapper;
      CardanoAPI._disconnection = [false];
      CardanoAPI._returnType = ['cbor'];
      window.addEventListener('yoroi_wallet_disconnected', function () {
        if (!CardanoAPI._disconnection[0]) {
          CardanoAPI._disconnection[0] = true;
          CardanoAPI._disconnection.slice(1).forEach(f => f());
        }
      });
    }

    cip95 = Object.freeze({
      getPubDRepKey: () => {
        return CardanoAPI._cardano_rpc_call('get_drep_key', []);
      },

      getRegisteredPubStakeKeys: () => {
        return CardanoAPI._cardano_rpc_call('get_stake_key', []).then(({ key, isRegistered }) => (isRegistered ? [key] : []));
      },

      getUnregisteredPubStakeKeys: () => {
        return CardanoAPI._cardano_rpc_call('get_stake_key', []).then(({ key, isRegistered }) => (isRegistered ? [] : [key]));
      },

      signData(address, payload) {
        return CardanoAPI._cardano_rpc_call('cip95_sign_data', [address, payload]);
      },
    });

    cip103 = Object.freeze({
      signTxs: async txs => {
        if (!Array.isArray(txs)) {
          throw new Error('.cip103.signTxs argument is expected to be an array!');
        }
        const batch = txs.slice();
        CardanoAPI._assertCip103BatchSize(batch, 'signTxs');
        const requests = batch.map((txRequest, index) => {
          try {
            return CardanoAPI._normalizeCip103SignRequest(CardanoAPI._snapshotCip103SignRequest(txRequest));
          } catch (error) {
            throw CardanoAPI._withCip103FailureIndex(error, index);
          }
        });

        const witnesses = [];
        for (let index = 0; index < requests.length; index++) {
          try {
            witnesses.push(await CardanoAPI._cardano_rpc_cbor_call('sign_tx/cardano', [requests[index]]));
          } catch (error) {
            throw CardanoAPI._withCip103FailureIndex(error, index);
          }
        }
        return witnesses;
      },

      submitTxs: async txs => {
        if (!Array.isArray(txs)) {
          throw new Error('.cip103.submitTxs argument is expected to be an array!');
        }
        const batch = txs.slice();
        CardanoAPI._assertCip103BatchSize(batch, 'submitTxs');

        const results = [];
        for (const tx of batch) {
          try {
            results.push({
              ok: true,
              value: await CardanoAPI._cardano_rpc_cbor_call('submit_tx', [tx]),
            });
          } catch (error) {
            results.push({ ok: false, value: error });
          }
        }
        const values = results.map(result => result.value);
        if (results.some(result => !result.ok)) {
          // CIP-0103 throws the mixed result array; successful hashes in it may already be on-chain.
          throw values;
        }
        return values;
      },
    });

    static _assertCip103BatchSize(txs, methodName) {
      if (txs.length > MAX_CIP103_TXS) {
        throw new Error(`.cip103.${methodName} supports at most ${MAX_CIP103_TXS} transactions per request!`);
      }
    }

    static _snapshotCip103SignRequest(txRequest) {
      if (txRequest == null || typeof txRequest !== 'object') {
        return txRequest;
      }
      return {
        cbor: txRequest.cbor,
        partialSign: txRequest.partialSign,
      };
    }

    static _withCip103FailureIndex(error, index) {
      const hasErrorInfo = error != null && typeof error === 'object' && typeof error.info === 'string';
      const hasErrorMessage = error != null && typeof error === 'object' && typeof error.message === 'string';
      let info = `Transaction at index ${index} failed`;
      if (hasErrorInfo) {
        info = `${error.info} (transaction index ${index})`;
      } else if (hasErrorMessage) {
        info = `${error.message} (transaction index ${index})`;
      }
      if (error != null && typeof error === 'object') {
        return { ...error, index, info };
      }
      return { index, info, error };
    }

    experimental = Object.freeze({
      setReturnType: returnType => {
        if (returnType !== 'cbor' && returnType !== 'json') {
          throw new Error('Possible return type values are: "cbor" or "json"');
        }
        CardanoAPI._returnType[0] = returnType;
      },

      auth: () => {
        // <TODO:PENDING_REMOVAL> experimental
        console.warn(`
          WARNING!! YOROI-EXPERIMENTAL function "auth" is about to be removed.
          Migrate to some other API for authentication immediately.
        `);
        return CardanoAPI._auth;
      },

      createTx: req => {
        // <TODO:PENDING_REMOVAL> experimental
        console.warn(`
          WARNING!! YOROI-EXPERIMENTAL function "createTx" is about to be removed.
          Migrate to some other API for transaction building immediately.
        `);
        return CardanoAPI._cardano_rpc_call('create_tx/cardano', [req]);
      },

      listNFTs: () => {
        return CardanoAPI._cardano_rpc_call('list_nfts/cardano', []);
      },

      onDisconnect: callback => {
        if (CardanoAPI._disconnection[0]) {
          throw new Error('Cardano API instance is already disconnected!');
        }
        CardanoAPI._disconnection.push(callback);
      },
    });

    static _normalizeCip103SignRequest(txRequest) {
      if (txRequest == null || typeof txRequest !== 'object') {
        throw new Error('.cip103.signTxs transaction request is expected to be an object!');
      }
      const tx = txRequest.cbor;
      if (typeof tx !== 'string') {
        throw new Error('.cip103.signTxs transaction request requires a cbor string!');
      }
      if (txRequest.partialSign !== undefined && typeof txRequest.partialSign !== 'boolean') {
        throw CardanoAPI._cip103InvalidRequest('.cip103.signTxs transaction request partialSign must be a boolean!');
      }
      return {
        tx,
        partialSign: txRequest.partialSign === true,
        returnTx: false,
      };
    }

    static _cip103InvalidRequest(info) {
      return { code: API_INVALID_REQUEST, info };
    }

    getExtensions() {
      const extensions = [{ cip: 95 }];
      if (this.cip103 != null && typeof this.cip103.signTxs === 'function' && typeof this.cip103.submitTxs === 'function') {
        extensions.push({ cip: 103 });
      }
      return Promise.resolve(extensions);
    }

    getNetworkId() {
      return CardanoAPI._cardano_rpc_call('get_network_id', []);
    }

    getBalance(token_id = '*') {
      return CardanoAPI._cardano_rpc_call('get_balance', [token_id]);
    }

    getUsedAddresses(paginate = undefined) {
      return CardanoAPI._cardano_rpc_call('get_used_addresses', [paginate]);
    }

    getUnusedAddresses() {
      return CardanoAPI._cardano_rpc_call('get_unused_addresses', []);
    }

    getRewardAddresses() {
      return CardanoAPI._cardano_rpc_call('get_reward_addresses/cardano', []);
    }

    getChangeAddress() {
      return CardanoAPI._cardano_rpc_call('get_change_address', []);
    }

    getUtxos(amount = undefined, paginate = undefined) {
      return CardanoAPI._cardano_rpc_call('get_utxos/cardano', [amount, paginate]);
    }

    submitTx(tx) {
      return CardanoAPI._cardano_rpc_call('submit_tx', [tx]);
    }

    signTx(param, _partialSign = false) {
      if (param == null) {
        throw new Error('.signTx argument cannot be null!');
      }
      let tx = param;
      let partialSign = _partialSign;
      let returnTx = false;
      if (typeof param === 'object') {
        tx = param.tx;
        partialSign = param.partialSign === undefined ? false : param.partialSign;
        returnTx = param.returnTx;
      } else if (typeof param !== 'string') {
        throw new Error('.signTx argument is expected to be an object or a string!');
      }
      if (typeof partialSign !== 'boolean') {
        throw new Error('.signTx partialSign must be a boolean!');
      }
      return CardanoAPI._cardano_rpc_call('sign_tx/cardano', [{ tx, partialSign, returnTx }]);
    }

    signData(address, payload) {
      return CardanoAPI._cardano_rpc_call('sign_data', [address, payload]);
    }

    // DEPRECATED
    getCollateralUtxos(requiredAmount) {
      const amount = typeof requiredAmount === 'object' ? requiredAmount.amount : requiredAmount;
      const strAmount = amount == null || amount === '' ? null : String(amount);
      return CardanoAPI._cardano_rpc_call('get_collateral_utxos', [strAmount]);
    }

    getCollateral(requiredAmount) {
      const amount = typeof requiredAmount === 'object' ? requiredAmount.amount : requiredAmount;
      const strAmount = amount == null || amount === '' ? null : String(amount);
      return CardanoAPI._cardano_rpc_call('get_collateral_utxos', [strAmount]);
    }
  }
  window.CardanoAPI = CardanoAPI;

  window.postMessage({ type: 'scripted_injected' });
})();
