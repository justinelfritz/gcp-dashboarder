import { useState } from 'react'
import type { Auth } from '../auth/useAuth'
import { AuthenticatorDialog, SignInDialog, VerifyEmailDialog } from './AuthDialogs'

/**
 * Header control: "Sign in" for guests; the account's email and "Sign out" once signed in. A new
 * account's remaining setup steps (verify the email, add an authenticator if required) open automatically.
 */
export default function AccountMenu({ auth }: { auth: Auth }) {
  const [open, setOpen] = useState(false)
  const { state } = auth
  if (state.status === 'disabled' || state.status === 'loading') return null
  if (state.status === 'signed-out') {
    const close = () => {
      setOpen(false)
      auth.clearNotice()
    }
    return (
      <span className="account">
        <button type="button" className="secondary" onClick={() => setOpen(true)}>Sign in</button>
        {(open || auth.notice) && <SignInDialog auth={auth} onClose={close} />}
      </span>
    )
  }
  return (
    <span className="account">
      <span className="account-email" title="Signed in">{state.user.email}</span>
      <button type="button" className="link" onClick={() => void auth.signOut()}>Sign out</button>
      {state.status === 'verify-email' && <VerifyEmailDialog auth={auth} email={state.user.email ?? ''} />}
      {state.status === 'setup-authenticator' && <AuthenticatorDialog auth={auth} />}
    </span>
  )
}
