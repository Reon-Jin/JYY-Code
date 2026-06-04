import { type JSX, splitProps } from 'solid-js'

interface CardProps {
  children: JSX.Element
  elevated?: boolean // 是否带阴影
  hoverable?: boolean // hover 时出现阴影
  dark?: boolean // 暗色表面
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

  const paddings = { none: '0', sm: '16px', md: '24px', lg: '32px 24px' }

  const cardStyle: JSX.CSSProperties = {
    background: local.dark
      ? 'var(--color-dark-surface-1)'
      : 'var(--color-gray-light)',
    'border-radius': 'var(--radius-standard)',
    padding: paddings[local.padding || 'md'],
    border: 'none',
    cursor: local.onClick ? 'pointer' : 'default',
    transition: 'box-shadow 0.3s ease',
    ...(local.elevated ? { 'box-shadow': 'var(--shadow-card)' } : {}),
    ...local.style,
  }

  return (
    <>
      <style>{`
        .card-hoverable:hover {
          box-shadow: var(--shadow-card);
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
