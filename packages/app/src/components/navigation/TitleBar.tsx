export function TitleBar() {
  return (
    <div class="titlebar" data-tauri-drag-region>
      <div class="window-controls">
        <button onClick={() => window.electron?.closeWindow()} title="Close" />
        <button onClick={() => window.electron?.minimizeWindow()} title="Minimize" />
        <button onClick={() => window.electron?.maximizeWindow()} title="Maximize" />
      </div>
      <div class="titlebar-center">JYYCode</div>
      <div class="titlebar-spacer" />
    </div>
  )
}
