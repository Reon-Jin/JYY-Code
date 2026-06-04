interface Props {
  onClick: () => void
}

export function CreateSessionFab(props: Props) {
  return (
    <button class="new-task-fab" onClick={props.onClick} title="New task">
      +
    </button>
  )
}
