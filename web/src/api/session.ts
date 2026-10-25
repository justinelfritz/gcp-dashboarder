import { api } from './client'

const STORAGE_KEY = 'dashboarder.session_id'

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function store(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Storage unavailable (private mode etc.): the session lasts for this page load only.
  }
}

/** Returns this browser's session ID, creating one on the API if none is stored. */
export async function getOrCreateSessionId(): Promise<string> {
  const existing = readStored()
  if (existing) return existing
  const { session_id } = await api.createSession()
  store(session_id)
  return session_id
}
