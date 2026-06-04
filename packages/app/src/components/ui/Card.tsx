import { type JSX, splitProps } from 'solid-js'

interface CardProps {
  children: JSX.Element
  elevated?: boolean
  hoverable?: boolean
  dark?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
  class?: string
  style?: JSX.CSSProperties
  onClick?: () => void
}

export function Card(props: CardProps) {
  const [local, rest] = splitProps(props, [
    'elevated',
    'hoverable',
    'dark',
    'padding',
    'class',
    'style',
    'children',
    'onClick',
  ])

  const paddings = { none: '0', sm: '16px', md: '24px', lg: '32px 28px' }

  const cardStyle: JSX.CSSProperties = {
    background: local.dark
      ? 'var(--clr-dark-surface)'
      : 'var(--clr-dark-surface)',
    'border-radius': 'var(--radius-generous)',
    padding: paddings[local.padding || 'md'],
    border: '1px solid var(--clr-border-dark)',
    cursor: local.onClick ? 'pointer' : 'default',
    transition: 'box-shadow 0.2s ease, background 0.2s ease',
    ...(local.elevated
      ? { 'box-shadow': 'var(--whisper-shadow)' }
      : {}),
    ...local.style,
  }

  return (
    <>
      <style>{`
        .card-hoverable:hover {
          box-shadow: var(--whisper-shadow);
          background: #3a3a37;
        }
      `}</style>
      <div
        style={cardStyle}
        class={`${local.hoverable ? 'card-hoverable' : ''} ${local.class || ''}`}
        onClick={local.onClick}
        {...rest}
      >
        {local.children}
      </div>
    </>
  )
}
