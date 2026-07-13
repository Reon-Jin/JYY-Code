import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { beforeEach, describe, expect, it } from "vitest"
import { Dialog } from "./dialog"

describe("Dialog", () => {
  beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      close: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.removeAttribute("open")
          this.dispatchEvent(new Event("close"))
        },
      },
      showModal: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.setAttribute("open", "")
        },
      },
    })
  })

  it("closes on Escape and returns focus to its trigger", async () => {
    const user = userEvent.setup()

    function Harness() {
      const [open, setOpen] = createSignal(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开设置
          </button>
          <Dialog open={open()} title="设置" onClose={() => setOpen(false)}>
            <button type="button">保存</button>
          </Dialog>
        </>
      )
    }

    render(() => <Harness />)
    const trigger = screen.getByRole("button", { name: "打开设置" })
    await user.click(trigger)

    const dialog = screen.getByRole("dialog", { name: "设置" })
    expect(dialog).toHaveAttribute("open")
    fireEvent(dialog, new Event("cancel", { cancelable: true }))

    await waitFor(() => {
      expect(dialog).not.toHaveAttribute("open")
      expect(trigger).toHaveFocus()
    })
  })
})
