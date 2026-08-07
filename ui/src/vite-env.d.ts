/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Homeserver pre-selected on the sign-in page (see src/branding.ts). */
  readonly VITE_DEFAULT_HOMESERVER?: string
  /** Display name for that homeserver. Defaults to its hostname. */
  readonly VITE_HOMESERVER_LABEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
