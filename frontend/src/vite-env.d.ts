/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the API origin. Defaults to the Vite proxy at `/api`. */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
