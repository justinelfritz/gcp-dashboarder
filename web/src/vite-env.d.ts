/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  /** e.g. http://127.0.0.1:9099 to use the local Firebase Auth emulator. */
  readonly VITE_FIREBASE_AUTH_EMULATOR_URL?: string
  /** 'false' only for emulator runs: the emulator can't do authenticator (TOTP) codes. */
  readonly VITE_REQUIRE_SECOND_FACTOR?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
