import { A } from '@solidjs/router'

const navItems = [
  { label: 'Home', path: '/', short: 'H' },
  { label: 'Email', path: '/email', short: 'M' },
]

export function Sidebar() {
  return (
    <nav class="app-sidebar">
      <div class="sidebar-brand">JYYCode</div>
      <div class="sidebar-nav">
        {navItems.map((item) => (
          <A href={item.path} class="sidebar-link" activeClass="active" end={item.path === '/'}>
            <span>{item.short}</span>
            <strong>{item.label}</strong>
          </A>
        ))}
      </div>
      <div class="sidebar-footer">
        <span class="status-dot" data-state="on" />
        <span>Gateway</span>
      </div>
    </nav>
  )
}
