import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { authErrorMessage, requireSecondFactor } from '../auth/firebase'
import type { AuthenticatorSetup } from '../auth/firebase'
import type { Auth } from '../auth/useAuth'

const MIN_PASSWORD = 10

function Dialog({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input')?.focus()
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => onClose && e.target === e.currentTarget && onClose()}>
      <div className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="auth-title" ref={ref}>
        <h2 id="auth-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** Runs an async step, tracking busy state and turning failures into a readable message. */
function useStep() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (step: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await step()
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      6-digit code from your authenticator app
      <input
        className="code-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </label>
  )
}

type Mode = 'sign-in' | 'create' | 'reset'

export function SignInDialog({ auth, onClose }: { auth: Auth; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [finish, setFinish] = useState<((code: string) => Promise<void>) | null>(null)
  const [resetSent, setResetSent] = useState(false)
  const { busy, error, run } = useStep()
  const addr = email.trim()

  if (finish) {
    return (
      <Dialog title="Enter your code" onClose={onClose}>
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await finish(code); onClose() }) }}>
          <p className="status">Open your authenticator app and enter the current code for Custom Dashboarder.</p>
          <CodeInput value={code} onChange={setCode} />
          {error && <p className="status status-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy || code.length !== 6}>Sign in</button>
          </div>
        </form>
      </Dialog>
    )
  }

  if (mode === 'reset') {
    return (
      <Dialog title="Reset your password" onClose={onClose}>
        {resetSent ? (
          <>
            <p>If an account uses <strong>{addr}</strong>, we’ve emailed it a link to choose a new password.</p>
            <div className="modal-actions">
              <button type="button" onClick={() => { setMode('sign-in'); setResetSent(false) }}>Back to sign in</button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await auth.resetPassword(addr); setResetSent(true) }) }}>
            <label className="field">
              Email
              <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {error && <p className="status status-error">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setMode('sign-in')}>Back</button>
              <button type="submit" disabled={busy || !addr}>Email me a reset link</button>
            </div>
          </form>
        )}
      </Dialog>
    )
  }

  const creating = mode === 'create'
  const mismatch = creating && confirm.length > 0 && confirm !== password
  const ready = addr && (creating ? password.length >= MIN_PASSWORD && confirm === password : password)
  const submit = () => run(async () => {
    // Close once signed in, so signing out later doesn't reopen this dialog. Any remaining
    // setup steps (verify the email, maybe add an authenticator) open on their own.
    if (creating) {
      await auth.createAccount(addr, password)
      onClose()
      return
    }
    const result = await auth.signIn(addr, password)
    if (result.needsCode) setFinish(() => result.finish)
    else onClose()
  })

  return (
    <Dialog title={creating ? 'Create an account' : 'Sign in'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit() }}>
        {auth.notice && <p className="status status-ok">{auth.notice}</p>}
        {!auth.notice && (
          <p className="status">
            {creating
              ? 'Your uploads are kept in your account until you delete them, on any device you sign in from.' +
                (requireSecondFactor ? ' Sign-in uses your password plus a code from an authenticator app.' : '')
              : requireSecondFactor
                ? 'Use your email, password, and the code from your authenticator app.'
                : 'Use your email and password.'}
          </p>
        )}
        <label className="field">
          Email
          <input type="email" required autoComplete={creating ? 'email' : 'username'} value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input type="password" required autoComplete={creating ? 'new-password' : 'current-password'}
            minLength={creating ? MIN_PASSWORD : undefined} value={password} onChange={(e) => setPassword(e.target.value)}
            aria-describedby={creating ? 'password-hint' : undefined} />
        </label>
        {creating && <p id="password-hint" className="hint">At least {MIN_PASSWORD} characters.</p>}
        {creating && (
          <label className="field">
            Confirm password
            <input type="password" required autoComplete="new-password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch}
              aria-describedby={mismatch ? 'confirm-hint' : undefined} />
          </label>
        )}
        {mismatch && <p id="confirm-hint" className="hint status-error">The passwords don’t match.</p>}
        {error && <p className="status status-error">{error}</p>}
        <div className="modal-actions">
          {creating ? (
            <button type="button" className="link" onClick={() => setMode('sign-in')}>I have an account</button>
          ) : (
            <>
              <button type="button" className="link" onClick={() => setMode('create')}>Create an account</button>
              <button type="button" className="link" onClick={() => setMode('reset')}>Forgot password?</button>
            </>
          )}
          <span className="spacer" />
          <button type="submit" disabled={busy || !ready}>{creating ? 'Create account' : 'Continue'}</button>
        </div>
      </form>
    </Dialog>
  )
}

/**
 * New account, step 1: verify the email, which password resets go to (and which Firebase requires
 * before an authenticator can be added).
 */
export function VerifyEmailDialog({ auth, email }: { auth: Auth; email: string }) {
  const { busy, error, run } = useStep()
  const [checked, setChecked] = useState(false)
  const [resent, setResent] = useState(false)
  return (
    <Dialog title="Verify your email">
      <p>
        We sent a verification email to <strong>{email}</strong>. Open the link in it, then come back here.
        This is needed once{requireSecondFactor ? ', before you add an authenticator app' : ''}. It may land in
        your spam folder.
      </p>
      {checked && !busy && !error && <p className="status status-error">Not verified yet. Open the link in the email first.</p>}
      {resent && <p className="status status-ok">Sent again.</p>}
      {error && <p className="status status-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="link" disabled={busy}
          onClick={() => void run(async () => { await auth.resendVerification(); setResent(true) })}>
          Resend email
        </button>
        <button type="button" className="link" onClick={() => void auth.signOut()}>Sign out</button>
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={() => void run(async () => { setChecked(false); await auth.refresh(); setChecked(true) })}>
          I’ve verified it
        </button>
      </div>
    </Dialog>
  )
}

/** New account, step 2 when codes are required: enroll an authenticator app by QR code (or key). */
export function AuthenticatorDialog({ auth }: { auth: Auth }) {
  const [setup, setSetup] = useState<AuthenticatorSetup | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [showKey, setShowKey] = useState(false)
  const { busy, error, run } = useStep()
  const start = auth.startAuthenticatorSetup

  useEffect(() => {
    let cancelled = false
    void run(async () => {
      const s = await start()
      // The QR library is only needed here; load it on demand.
      const { default: qrcode } = await import('qrcode-generator')
      const q = qrcode(0, 'M')
      q.addData(s.otpauthUrl)
      q.make()
      if (cancelled) return
      setSetup(s)
      setQr(q.createDataURL(5, 2))
    })
    return () => {
      cancelled = true
    }
    // Runs once per dialog: each start creates a new secret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start])

  return (
    <Dialog title="Set up your authenticator app">
      <form onSubmit={(e) => { e.preventDefault(); if (setup) void run(() => setup.finish(code)) }}>
        <p className="status">
          Scan this with an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator…),
          then enter the 6-digit code it shows. You’ll need a code from it each time you sign in.
        </p>
        <div className="qr">
          {qr ? <img src={qr} alt="QR code for your authenticator app" width={200} height={200} /> : <p className="status">Preparing…</p>}
        </div>
        {setup && (
          <p className="status">
            {showKey ? (
              <>Key: <code className="secret-key">{setup.secretKey}</code></>
            ) : (
              <button type="button" className="link" onClick={() => setShowKey(true)}>Can’t scan? Show the key to type in</button>
            )}
          </p>
        )}
        <CodeInput value={code} onChange={setCode} />
        {error && <p className="status status-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={() => void auth.signOut()}>Sign out</button>
          <span className="spacer" />
          <button type="submit" disabled={busy || !setup || code.length !== 6}>Finish setup</button>
        </div>
      </form>
    </Dialog>
  )
}
