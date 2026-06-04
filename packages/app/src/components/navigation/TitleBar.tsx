import { createSignal, onCleanup } from 'solid-js'

export function TitleBar() {
  const [maximized, setMaximized] = createSignal(false)

  // Listen to window state changes if possible
  // For now, use a simple approach

  const trafficLightStyle = {
    width: '12px',
    height: '12px',
    'border-radius': '50%',
    border: 'none',
    cursor: 'pointer',
    display: 'inline-block',
    'margin-right': '8px',
    transition: 'filter 0.1s',
  }

  function handleClose() {
    window.electron?.closeWindow()
  }
  function handleMinimize() {
    window.electron?.minimizeWindow()
  }
  function handleMaximize() {
    window.electron?.maximizeWindow()
    setMaximized(!maximized())
  }

  return (
    <div style={{
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'space-between',
      height: '38px',
      padding: '0 12px',
      background: 'var(--nav-bg)',
      'backdrop-filter': 'var(--nav-blur)',
      '-webkit-backdrop-filter': 'var(--nav-blur)',
      '-webkit-app-region': 'drag',
      'user-select': 'none',
      'z-index': '200',
      'flex-shrink': '0',
    }} data-tauri-drag-region>
      {/* Traffic Lights */}
      <div style={{ display: 'flex', 'align-items': 'center', '-webkit-app-region': 'no-drag' }}>
        <button
          onClick={handleClose}
          style={{ ...trafficLightStyle, background: '#ff5f57' }}
          title="关闭"
          onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(0.8)')}
          onMouseLeave={(e) => (e.currentTarget.style.filter = 'none')}
        />
        <button
          onClick={handleMinimize}
          style={{ ...trafficLightStyle, background: '#febc2e' }}
          title="最小化"
          onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(0.8)')}
          onMouseLeave={(e) => (e.currentTarget.style.filter = 'none')}
        />
        <button
          onClick={handleMaximize}
          style={{ ...trafficLightStyle, background: '#28c840' }}
          title="全屏"
          onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(0.8)')}
          onMouseLeave={(e) => (e.currentTarget.style.filter = 'none')}
        />
      </div>

      {/* App Title */}
      <div style={{
        'font-family': 'var(--font-text)',
        'font-size': '13px',
        'font-weight': '600',
        color: 'var(--color-text-white)',
        'letter-spacing': '-0.26px',
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
      }}>
        JYYCode
      </div>

      {/* Spacer for symmetry */}
      <div style={{ width: '60px' }} />
    </div>
  )
}
