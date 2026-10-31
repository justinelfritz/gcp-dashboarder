// Firebase Authentication: email + password, optionally plus a code from an authenticator app
// (TOTP) as a second factor. The SDK is imported lazily, and only when sign-in is configured, so
// guest-only builds never download it.
import type { Auth, MultiFactorError, User } from 'firebase/auth'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
}
const EMULATOR_URL = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL
const ISSUER = 'Custom Dashboarder'

export const signInEnabled = Boolean(config.apiKey && config.projectId)
/**
 * Also require an authenticator code (TOTP) at sign-in. Off unless built with
 * VITE_REQUIRE_SECOND_FACTOR=true; needs Identity Platform, and the API's matching setting.
 */
export const requireSecondFactor = import.meta.env.VITE_REQUIRE_SECOND_FACTOR === 'true'

export interface AuthUser {
  uid: string
  email: string | null
  emailVerified: boolean
  /** An authenticator app is enrolled on the account. */
  hasAuthenticator: boolean
  /** This sign-in used the authenticator code. */
  usedSecondFactor: boolean
}

let authPromise: Promise<{ auth: Auth; sdk: typeof import('firebase/auth') }> | null = null

function load() {
  authPromise ??= (async () => {
    const [{ initializeApp }, sdk] = await Promise.all([import('firebase/app'), import('firebase/auth')])
    const auth = sdk.getAuth(initializeApp(config))
    if (EMULATOR_URL) sdk.connectAuthEmulator(auth, EMULATOR_URL, { disableWarnings: true })
    return { auth, sdk }
  })()
  return authPromise
}

const returnUrl = () => ({ url: window.location.origin + window.location.pathname })

async function describe(user: User): Promise<AuthUser> {
  const { sdk } = await load()
  let token = await user.getIdTokenResult()
  // A token issued before the email was verified still says it isn't, and the API goes by the
  // token. On page load the SDK re-reads the account but keeps that token, so refresh it first.
  if (user.emailVerified && token.claims.email_verified !== true) token = await user.getIdTokenResult(true)
  const firebase = token.claims.firebase as { sign_in_second_factor?: string } | undefined
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    hasAuthenticator: sdk.multiFactor(user).enrolledFactors
      .some((f) => f.factorId === sdk.TotpMultiFactorGenerator.FACTOR_ID),
    usedSecondFactor: Boolean(firebase?.sign_in_second_factor),
  }
}

/**
 * Calls back with the signed-in user (or null) now and whenever the sign-in or its token changes,
 * e.g. after verifying the email or enrolling an authenticator. Returns an unsubscribe.
 */
export async function watchUser(onChange: (user: AuthUser | null) => void): Promise<() => void> {
  const { auth, sdk } = await load()
  return sdk.onIdTokenChanged(auth, (u) => {
    if (!u) onChange(null)
    else void describe(u).then(onChange)
  })
}

export async function idToken(): Promise<string | null> {
  if (!signInEnabled) return null
  const { auth } = await load()
  return (await auth.currentUser?.getIdToken()) ?? null
}

/** Creates the account (now signed in with the password only) and emails a verification link. */
export async function createAccount(email: string, password: string): Promise<void> {
  const { auth, sdk } = await load()
  const { user } = await sdk.createUserWithEmailAndPassword(auth, email, password)
  await sdk.sendEmailVerification(user, returnUrl())
}

export async function resendVerification(): Promise<void> {
  const { auth, sdk } = await load()
  if (auth.currentUser) await sdk.sendEmailVerification(auth.currentUser, returnUrl())
}

/** Re-reads the account (e.g. after the email was verified in another tab) and refreshes its token. */
export async function refreshUser(): Promise<void> {
  const { auth } = await load()
  if (!auth.currentUser) return
  await auth.currentUser.reload()
  await auth.currentUser.getIdToken(true)
}

export type SignInResult =
  | { needsCode: false }
  // The password was right; finish with a code from the authenticator app.
  | { needsCode: true; finish: (code: string) => Promise<void> }

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const { auth, sdk } = await load()
  try {
    await sdk.signInWithEmailAndPassword(auth, email, password)
    return { needsCode: false }
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/multi-factor-auth-required') throw err
    const resolver = sdk.getMultiFactorResolver(auth, err as MultiFactorError)
    const hint = resolver.hints.find((h) => h.factorId === sdk.TotpMultiFactorGenerator.FACTOR_ID)
    if (!hint) throw new Error('This account has no authenticator app set up.')
    return {
      needsCode: true,
      finish: async (code) => {
        await resolver.resolveSignIn(sdk.TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code))
      },
    }
  }
}

export interface AuthenticatorSetup {
  /** otpauth:// URL for the QR code. */
  otpauthUrl: string
  /** The same secret, for typing into an app that can't scan. */
  secretKey: string
  finish: (code: string) => Promise<void>
}

/** Starts enrolling an authenticator app on the signed-in account. */
export async function startAuthenticatorSetup(): Promise<AuthenticatorSetup> {
  const { auth, sdk } = await load()
  const user = auth.currentUser
  if (!user) throw new Error('Sign in first.')
  const session = await sdk.multiFactor(user).getSession()
  const secret = await sdk.TotpMultiFactorGenerator.generateSecret(session)
  return {
    otpauthUrl: secret.generateQrCodeUrl(user.email ?? 'account', ISSUER),
    secretKey: secret.secretKey,
    finish: async (code) => {
      await sdk.multiFactor(user).enroll(sdk.TotpMultiFactorGenerator.assertionForEnrollment(secret, code), 'Authenticator app')
      await user.getIdToken(true)
    },
  }
}

/** Emails a password-reset link. Says nothing about whether the account exists. */
export async function resetPassword(email: string): Promise<void> {
  const { auth, sdk } = await load()
  try {
    await sdk.sendPasswordResetEmail(auth, email, returnUrl())
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err
  }
}

export async function signOutUser(): Promise<void> {
  const { auth, sdk } = await load()
  await sdk.signOut(auth)
}

const MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/invalid-email': 'That email address isn’t valid.',
  'auth/email-already-in-use': 'An account already uses this email. Sign in instead.',
  'auth/weak-password': 'Choose a longer password.',
  'auth/password-does-not-meet-requirements': 'Choose a longer, stronger password.',
  'auth/invalid-verification-code': 'That code didn’t match. Check the app and try again.',
  'auth/missing-code': 'Enter the 6-digit code from your authenticator app.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/requires-recent-login': 'For security, sign out and sign in again, then set up your authenticator.',
  'auth/unverified-email': 'Verify your email address first.',
  'auth/operation-not-allowed': 'This sign-in method isn’t enabled on the server.',
  'auth/network-request-failed': 'Can’t reach the sign-in service. Check your connection.',
}

/** A message for the user; never the raw Firebase error. */
export function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string }).code
  if (code && MESSAGES[code]) return MESSAGES[code]
  if (err instanceof Error && !code) return err.message
  return 'Something went wrong. Try again.'
}
