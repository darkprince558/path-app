/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Guest link (…/s/<shareId>) that the landing page's QR codes open on a phone. */
  readonly VITE_DEMO_SHARE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
