/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Homeserver pre-selected on the sign-in page (see src/branding.ts). */
  readonly VITE_DEFAULT_HOMESERVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
