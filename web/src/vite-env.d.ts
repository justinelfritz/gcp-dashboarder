/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  /** e.g. http://127.0.0.1:9099 to use the local Firebase Auth emulator. */
  readonly VITE_FIREBASE_AUTH_EMULATOR_URL?: string
  /** 'true' requires an authenticator (TOTP) code at sign-in. Needs Identity Platform; the emulator can't. */
  readonly VITE_REQUIRE_SECOND_FACTOR?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
