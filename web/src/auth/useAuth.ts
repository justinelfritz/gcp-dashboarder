import { useCallback, useEffect, useState } from 'react'
import { setAuthTokenGetter } from '../api/client'
import * as fb from './firebase'
import type { AuthUser } from './firebase'

export type AuthState =
  | { status: 'disabled' } // sign-in isn't configured: guest sessions only
  | { status: 'loading' }
  | { status: 'signed-out' }
  // Signed in with the password, and the account isn't ready yet:
  | { status: 'verify-email'; user: AuthUser } // step 1 of a new account
  | { status: 'setup-authenticator'; user: AuthUser } // step 2, only when codes are required
  | { status: 'signed-in'; user: AuthUser }

export function stateFor(user: AuthUser | null): AuthState | 'needs-code' {
  if (!user) return { status: 'signed-out' }
  if (!user.emailVerified) return { status: 'verify-email', user }
  if (!fb.requireSecondFactor || user.usedSecondFactor) return { status: 'signed-in', user }
  if (!user.hasAuthenticator) return { status: 'setup-authenticator', user }
  // Has an authenticator but this sign-in didn't use it (e.g. right after enrolling, if the token
  // doesn't record it): sign in again with a code.
  return 'needs-code'
}

export function useAuth() {
  const [state, setState] = useState<AuthState>(fb.signInEnabled ? { status: 'loading' } : { status: 'disabled' })
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!fb.signInEnabled) return
    setAuthTokenGetter(fb.idToken)
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    fb.watchUser((user) => {
      const next = stateFor(user)
      if (next === 'needs-code') {
        setNotice('Your authenticator is set up. Sign in with your password and a code from the app.')
        void fb.signOutUser()
      } else {
        setState(next)
      }
    })
      .then((stop) => {
        if (cancelled) stop()
        else unsubscribe = stop
      })
      .catch(() => {
        setNotice('Sign-in is unavailable right now.')
        setState({ status: 'signed-out' })
      })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const clearNotice = useCallback(() => setNotice(null), [])

  return {
    state,
    /** A message to show in the sign-in dialog, e.g. after enrolling an authenticator. */
    notice,
    clearNotice,
    signIn: fb.signIn,
    createAccount: fb.createAccount,
    resendVerification: fb.resendVerification,
    refresh: fb.refreshUser,
    startAuthenticatorSetup: fb.startAuthenticatorSetup,
    resetPassword: fb.resetPassword,
    signOut: fb.signOutUser,
  }
}

export type Auth = ReturnType<typeof useAuth>
