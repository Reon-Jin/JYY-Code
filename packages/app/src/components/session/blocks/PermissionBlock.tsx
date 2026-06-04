import type { PermissionRequestPart } from '../../../types/models'
import { Button } from '../../ui/Button'

interface Props {
  part: PermissionRequestPart
  onApprove: () => void
  onDeny: () => void
}

export function PermissionBlock(props: Props) {
  return (
    <section class="permission-block">
      <div>
        <strong>{props.part.toolName} needs permission</strong>
        <p>{props.part.message}</p>
      </div>
      <div class="permission-actions">
        <Button variant="outline" size="sm" onClick={props.onDeny}>
          Deny
        </Button>
        <Button variant="primary" size="sm" onClick={props.onApprove}>
          Allow
        </Button>
      </div>
    </section>
  )
}
