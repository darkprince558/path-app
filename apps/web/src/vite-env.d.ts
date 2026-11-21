/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Account the local scan mock treats as signed in for owner actions such as upload and sharing (dev only). */
  readonly VITE_DEV_USER?: string;
  /** Name shown for that stand-in account in the app menu (dev only). */
  readonly VITE_DEV_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
