import "solid-js"

declare module "solid-js" {
  namespace JSX {
    interface OptionHTMLAttributes<T> {
      /**
       * Assign the `selected` DOM property instead of the content attribute,
       * so a re-created option list still reflects the controlled value.
       */
      "prop:selected"?: boolean
    }
  }
}
