import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Auth } from '../auth/useAuth'
import AccountMenu from './AccountMenu'

vi.mock('qrcode-generator', () => ({
  default: () => ({ addData: vi.fn(), make: vi.fn(), createDataURL: () => 'data:image/gif;base64,QR' }),
}))

const user = { uid: 'u', email: 'me@example.com', emailVerified: true, hasAuthenticator: true, usedSecondFactor: true }

function auth(state: Auth['state'], overrides: Partial<Auth> = {}): Auth {
  return {
    state,
    notice: null,
    clearNotice: vi.fn(),
    signIn: vi.fn(async () => ({ needsCode: false as const })),
    createAccount: vi.fn(async () => {}),
    resendVerification: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    startAuthenticatorSetup: vi.fn(async () => ({
      otpauthUrl: 'otpauth://totp/x', secretKey: 'ABCDEF234567', finish: vi.fn(async () => {}),
    })),
    resetPassword: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    ...overrides,
  }
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('AccountMenu', () => {
  it('is hidden when sign-in isn\'t configured', () => {
    const { container } = render(<AccountMenu auth={auth({ status: 'disabled' })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('signs in with a password, then an authenticator code', async () => {
    const finish = vi.fn(async () => {})
    const a = auth({ status: 'signed-out' }, { signIn: vi.fn(async () => ({ needsCode: true as const, finish })) })
    render(<AccountMenu auth={a} />)
    fireEvent.click(screen.getByText('Sign in'))
    type('Email', ' me@example.com ')
    type('Password', 'correct horse')
    fireEvent.click(screen.getByText('Continue'))
    expect(await screen.findByRole('dialog', { name: 'Enter your code' })).toBeInTheDocument()
    expect(a.signIn).toHaveBeenCalledWith('me@example.com', 'correct horse')
    // Only digits are kept.
    type('6-digit code from your authenticator app', '12a 3456')
    expect(screen.getByLabelText('6-digit code from your authenticator app')).toHaveValue('123456')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(finish).toHaveBeenCalledWith('123456'))
  })

  it('shows a readable error, never the raw Firebase one', async () => {
    const a = auth({ status: 'signed-out' }, {
      signIn: vi.fn(async () => { throw Object.assign(new Error('Firebase: Error (auth/invalid-credential).'), { code: 'auth/invalid-credential' }) }),
    })
    render(<AccountMenu auth={a} />)
    fireEvent.click(screen.getByText('Sign in'))
    type('Email', 'me@example.com')
    type('Password', 'nope')
    fireEvent.click(screen.getByText('Continue'))
    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument()
  })

  it('creates an account with a confirmed, long-enough password', async () => {
    const a = auth({ status: 'signed-out' })
    render(<AccountMenu auth={a} />)
    fireEvent.click(screen.getByText('Sign in'))
    fireEvent.click(screen.getByText('Create an account'))
    type('Email', 'me@example.com')
    type('Password', 'short')
    type('Confirm password', 'short')
    expect(screen.getByText('Create account')).toBeDisabled()
    type('Password', 'long enough pw')
    type('Confirm password', 'long enough px')
    expect(screen.getByText('The passwords don’t match.')).toBeInTheDocument()
    type('Confirm password', 'long enough pw')
    fireEvent.click(screen.getByText('Create account'))
    await waitFor(() => expect(a.createAccount).toHaveBeenCalledWith('me@example.com', 'long enough pw'))
    // The dialog closes, so a later sign-out doesn't bring it back.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('sends a password reset without revealing whether the account exists', async () => {
    const a = auth({ status: 'signed-out' })
    render(<AccountMenu auth={a} />)
    fireEvent.click(screen.getByText('Sign in'))
    fireEvent.click(screen.getByText('Forgot password?'))
    type('Email', 'me@example.com')
    fireEvent.click(screen.getByText('Email me a reset link'))
    expect(await screen.findByText(/If an account uses/)).toBeInTheDocument()
    expect(a.resetPassword).toHaveBeenCalledWith('me@example.com')
  })

  it('walks a new account through email verification', async () => {
    const a = auth({ status: 'verify-email', user: { ...user, emailVerified: false, hasAuthenticator: false, usedSecondFactor: false } })
    render(<AccountMenu auth={a} />)
    expect(screen.getByRole('dialog', { name: 'Verify your email' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('I’ve verified it'))
    await waitFor(() => expect(a.refresh).toHaveBeenCalled())
    fireEvent.click(screen.getByText('Resend email'))
    await waitFor(() => expect(a.resendVerification).toHaveBeenCalled())
  })

  it('enrolls an authenticator by QR code', async () => {
    const finish = vi.fn(async () => {})
    const a = auth({ status: 'setup-authenticator', user: { ...user, hasAuthenticator: false, usedSecondFactor: false } }, {
      startAuthenticatorSetup: vi.fn(async () => ({ otpauthUrl: 'otpauth://totp/x', secretKey: 'ABCDEF234567', finish })),
    })
    render(<AccountMenu auth={a} />)
    expect(await screen.findByAltText('QR code for your authenticator app')).toHaveAttribute('src', 'data:image/gif;base64,QR')
    fireEvent.click(screen.getByText('Can’t scan? Show the key to type in'))
    expect(screen.getByText('ABCDEF234567')).toBeInTheDocument()
    type('6-digit code from your authenticator app', '654321')
    fireEvent.click(screen.getByText('Finish setup'))
    await waitFor(() => expect(finish).toHaveBeenCalledWith('654321'))
    expect(a.startAuthenticatorSetup).toHaveBeenCalledTimes(1)
  })

  it('shows the account and signs out', () => {
    const a = auth({ status: 'signed-in', user })
    render(<AccountMenu auth={a} />)
    expect(screen.getByText('me@example.com')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Sign out'))
    expect(a.signOut).toHaveBeenCalled()
  })
})
