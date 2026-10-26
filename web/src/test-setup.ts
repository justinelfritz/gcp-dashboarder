import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library only auto-cleans with vitest globals enabled; this project doesn't use them.
afterEach(cleanup)
