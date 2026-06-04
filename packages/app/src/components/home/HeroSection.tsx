export function HeroSection() {
  return (
    <div style={{
      'text-align': 'center',
      padding: '80px 0 48px',
    }}>
      <h1 class="text-display-hero" style={{ 'margin-bottom': '16px' }}>
        JYYCode
      </h1>
      <p class="text-card-title" style={{
        color: 'var(--color-text-secondary)',
        'max-width': '500px',
        margin: '0 auto 32px',
      }}>
        Your AI Engineering Partner
      </p>
      <p class="text-body" style={{
        color: 'var(--color-text-tertiary)',
        'max-width': '460px',
        margin: '0 auto',
      }}>
        选择一个工作空间目录开始，或者打开最近的工程。
      </p>
    </div>
  )
}
