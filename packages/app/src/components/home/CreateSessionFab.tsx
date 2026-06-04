interface Props {
  onClick: () => void
}

export function CreateSessionFab(props: Props) {
  return (
    <button
      onClick={props.onClick}
      style={{
        position: 'fixed',
        bottom: '32px',
        right: '32px',
        width: '56px',
        height: '56px',
        'border-radius': '50%',
        background: 'var(--color-blue-apple)',
        color: 'var(--color-white)',
        border: 'none',
        'font-size': '24px',
        cursor: 'pointer',
        'box-shadow': '0 4px 12px rgba(0,113,227,0.4)',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        transition: 'transform 0.15s, box-shadow 0.15s',
        'z-index': '100',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.05)'
        e.currentTarget.style.boxShadow = '0 6px 16px rgba(0,113,227,0.5)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)'
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,113,227,0.4)'
      }}
      title="新建会话"
    >
      ✨
    </button>
  )
}
