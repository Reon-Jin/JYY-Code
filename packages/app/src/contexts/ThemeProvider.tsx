import { type ParentProps, createEffect, onMount } from 'solid-js'
import { useTheme } from '../hooks/useTheme'

/**
 * ThemeProvider - handles theme initialization and applies the `data-theme`
 * attribute on the document root. The app is dark-first (Claude design system);
 * the [data-theme] attribute is set for future light-mode support.
 *
 * Wrap the app root with this component.
 */
export function ThemeProvider(props: ParentProps) {
  const theme = useTheme()

  // On mount: apply persisted or system theme
  onMount(() => {
    document.documentElement.dataset.theme = theme.resolved()
  })

  // React to theme changes
  createEffect(() => {
    document.documentElement.dataset.theme = theme.resolved()
  })

  return <>{props.children}</>
}
