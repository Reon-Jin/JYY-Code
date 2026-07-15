import { Index } from "solid-js"

export type KeyValueRow = { key: string; value: string }

export type KeyValueEditorProps = {
  rows: KeyValueRow[]
  name: string
  addLabel: string
  onChange: (rows: KeyValueRow[]) => void
}

export function KeyValueEditor(props: KeyValueEditorProps) {
  const update = (index: number, field: keyof KeyValueRow, value: string) => {
    props.onChange(props.rows.map((row, current) => (current === index ? { ...row, [field]: value } : row)))
  }

  return (
    <div class="mcp-kv">
      <Index each={props.rows}>
        {(row, index) => (
          <div class="mcp-kv__row">
            <label>
              <span>
                {props.name}名称 {index + 1}
              </span>
              <input value={row().key} onInput={(event) => update(index, "key", event.currentTarget.value)} />
            </label>
            <label>
              <span>
                {props.name}值 {index + 1}
              </span>
              <input value={row().value} onInput={(event) => update(index, "value", event.currentTarget.value)} />
            </label>
            <button
              type="button"
              class="mcp-kv__remove"
              aria-label={`删除${props.name} ${index + 1}`}
              onClick={() => props.onChange(props.rows.filter((_, current) => current !== index))}
            >
              删除
            </button>
          </div>
        )}
      </Index>
      <button type="button" class="mcp-kv__add" onClick={() => props.onChange([...props.rows, { key: "", value: "" }])}>
        {props.addLabel}
      </button>
    </div>
  )
}
