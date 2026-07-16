import { tr } from "../../i18n/i18n-context"
import { Show, splitProps, type JSX, type ParentProps } from "solid-js"
import { Spinner } from "./spinner"

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
type ButtonSize = "small" | "medium" | "icon"

export type ButtonProps = ParentProps<
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant
    size?: ButtonSize
    loading?: boolean
    loadingLabel?: string
  }
>

export function Button(props: ButtonProps) {
  const [local, buttonProps] = splitProps(props, [
    "children",
    "class",
    "disabled",
    "loading",
    "loadingLabel",
    "size",
    "type",
    "variant",
  ])

  return (
    <button
      {...buttonProps}
      type={local.type ?? "button"}
      class={["ui-button", local.class].filter(Boolean).join(" ")}
      data-size={local.size ?? "medium"}
      data-variant={local.variant ?? "primary"}
      disabled={local.disabled || local.loading}
      aria-busy={local.loading ? "true" : undefined}
    >
      <Show when={local.loading}>
        <Spinner />
      </Show>
      {local.loading ? (local.loadingLabel ?? tr("components.processing")) : local.children}
    </button>
  )
}

export type IconButtonProps = Omit<ButtonProps, "aria-label" | "size"> & {
  label: string
}

export function IconButton(props: IconButtonProps) {
  const [local, buttonProps] = splitProps(props, ["label"])
  if (!local.label.trim()) throw new Error("IconButton requires a non-empty label")

  return <Button {...buttonProps} size="icon" aria-label={local.label} />
}
