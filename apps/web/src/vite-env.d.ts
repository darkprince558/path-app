/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Account the local scan mock treats as signed in for organizer actions (dev only). */
  readonly VITE_DEV_USER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
