type CmlApi = typeof import('@dcspark/cardano-multiplatform-lib-browser');

type CmlRuntimeScope = {
  CML: CmlApi;
};

export const RustModule: {
  load(): Promise<void>;
  CML: CmlApi;
  WasmScope<T>(callback: (module: CmlRuntimeScope) => T): T;
};
