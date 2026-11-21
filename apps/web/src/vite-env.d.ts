/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Account the local scan mock treats as signed in for owner actions such as upload and sharing (dev only). */
  readonly VITE_DEV_USER?: string;
  /** Name shown for that stand-in account in the app menu (dev only). */
  readonly VITE_DEV_NAME?: string;
  /** Guest link (…/s/<shareId>) that the landing page's QR codes open on a phone. */
  readonly VITE_DEMO_SHARE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
