import { useId } from 'react'
import type { ReactNode } from 'react'

/** A titled cluster of controls; the title also names the group for screen readers. */
export default function ControlGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <div className="control-group" role="group" aria-labelledby={id}>
      <span className="control-group-title" id={id}>{title}</span>
      <div className="control-group-body">{children}</div>
    </div>
  )
}
