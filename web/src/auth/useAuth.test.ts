import { describe, expect, it } from 'vitest'
import { stateFor } from './useAuth'

const user = { uid: 'u', email: 'me@example.com', emailVerified: true, hasAuthenticator: false, usedSecondFactor: false }

describe('stateFor (authenticator codes off, the default)', () => {
  it('asks a new account to verify its email first', () => {
    expect(stateFor({ ...user, emailVerified: false })).toEqual({ status: 'verify-email', user: { ...user, emailVerified: false } })
  })

  it('signs in with a verified email and a password alone', () => {
    expect(stateFor(user)).toEqual({ status: 'signed-in', user })
  })

  it('is signed out without a user', () => {
    expect(stateFor(null)).toEqual({ status: 'signed-out' })
  })
})
