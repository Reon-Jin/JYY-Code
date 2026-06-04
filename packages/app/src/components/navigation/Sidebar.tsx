import { A } from '@solidjs/router'
import { useTheme } from '../../hooks/useTheme'
import type { JSX } from 'solid-js'

interface NavItem {
  label: string
  icon: string
  path: string
  badge?: number
}

export function Sidebar() {
  const theme = useTheme()

  const navItems: NavItem[] = [
    { label: '主页', icon: '🏠', path: '/' },
    { label: '邮件', icon: '📬', path: '/email' },
  ]

  const sidebarStyle: JSX.CSSProperties = {
    width: '64px',
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'center',
    padding: 'var(--space-10) 0',
    background: 'var(--color-gray-light)',
    'border-right': '1px solid rgba(0,0,0,0.06)',
    'flex-shrink': '0',
    gap: 'var(--space-8)',
  }

  const navItemStyle = (active: boolean): JSX.CSSProperties => ({
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'center',
    gap: '4px',
    padding: 'var(--space-8) var(--space-4)',
    'border-radius': 'var(--radius-standard)',
    'text-decoration': 'none',
    color: active ? 'var(--color-blue-apple)' : 'var(--color-text-tertiary)',
    background: active ? 'rgba(0,113,227,0.06)' : 'transparent',
    transition: 'all 0.15s',
    width: '48px',
    cursor: 'pointer',
    position: 'relative',
    'font-size': '20px',
  })

  const labelStyle: JSX.CSSProperties = {
    'font-size': '10px',
    'font-weight': '500',
    'letter-spacing': '-0.08px',
  }

  // Simple active check (SolidJS router provides useLocation)
  // For brevity we pass isActive manually

  return (
    <nav style={sidebarStyle}>
      {navItems.map(item => (
        <A href={item.path} style={navItemStyle(false)} activeClass="sidebar-active" end={item.path === '/'}>
          <span style={{ position: 'relative' }}>
            {item.icon}
            {item.badge && item.badge > 0 && (
              <span style={{
                position: 'absolute',
                top: '-4px',
                right: '-8px',
                'min-width': '14px',
                height: '14px',
                'border-radius': '980px',
                background: 'var(--color-blue-apple)',
                color: 'white',
                'font-size': '9px',
                'font-weight': '600',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                padding: '0 3px',
              }}>{item.badge}</span>
            )}
          </span>
          <span style={labelStyle}>{item.label}</span>
        </A>
      ))}
    </nav>
  )
}
