import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UploadPanel from './UploadPanel'

const deleteAll = vi.fn<(scope: string) => Promise<{ objects_deleted: number }>>(async () => ({ objects_deleted: 12 }))
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: {
    library: async () => ({
      activities: 3, visible_activities: 3, first_date: '2026-09-01', last_date: '2026-10-01',
      files_stored: 3, bytes_stored: 2048,
    }),
    deleteAll: (scope: string) => deleteAll(scope),
  },
}))

describe('UploadPanel data and privacy', () => {
  afterEach(() => vi.clearAllMocks())

  it('deletes everything only after typing DELETE', async () => {
    const onDeletedAll = vi.fn()
    render(<UploadPanel scope="/me" signedIn onDeletedAll={onDeletedAll} />)
    await screen.findByTestId('library')
    fireEvent.click(screen.getByText('Your data and privacy'))
    fireEvent.click(screen.getByText('Delete my account and all data'))
    const dialog = screen.getByRole('dialog', { name: 'Delete your account?' })
    const submit = within(dialog).getByText('Delete permanently')
    expect(submit).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), { target: { value: 'delete' } })
    expect(submit).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } })
    fireEvent.click(submit)
    await waitFor(() => expect(onDeletedAll).toHaveBeenCalled())
    expect(deleteAll).toHaveBeenCalledWith('/me')
  })

  it('offers guests a data delete, not an account delete', async () => {
    render(<UploadPanel scope="/sessions/s" />)
    await screen.findByTestId('library')
    fireEvent.click(screen.getByText('Your data and privacy'))
    expect(screen.getByText('Delete all uploaded data')).toBeInTheDocument()
    expect(screen.queryByText(/Delete my account/)).not.toBeInTheDocument()
  })
})
