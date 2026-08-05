import { afterEach, describe, expect, it, vi } from "vitest"
import {
  handleSoundEffectEvent,
  publishSoundEffectsEnabled,
  resetSoundEffectsForTests,
  soundEffectForTarget,
  suppressNextBlackboardSound,
} from "./sound-effects"

describe("sound effect target mapping", () => {
  afterEach(() => resetSoundEffectsForTests())

  it("maps plain buttons and links to a click", () => {
    const button = document.createElement("button")
    button.textContent = "Go"
    expect(soundEffectForTarget(button)).toBe("click")

    const link = document.createElement("a")
    link.href = "/settings"
    expect(soundEffectForTarget(link)).toBe("click")
  })

  it("maps switches and checkboxes to toggle sounds", () => {
    const switchOn = document.createElement("button")
    switchOn.setAttribute("role", "switch")
    switchOn.setAttribute("aria-checked", "true")
    expect(soundEffectForTarget(switchOn)).toBe("toggle-off")

    const switchOff = document.createElement("button")
    switchOff.setAttribute("role", "switch")
    switchOff.setAttribute("aria-checked", "false")
    expect(soundEffectForTarget(switchOff)).toBe("toggle-on")

    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    expect(soundEffectForTarget(checkbox)).toBe("toggle-on")
    checkbox.checked = true
    expect(soundEffectForTarget(checkbox)).toBe("toggle-off")
  })

  it("maps menu choices and selects to the mode switch sound", () => {
    const item = document.createElement("button")
    item.setAttribute("role", "menuitemradio")
    expect(soundEffectForTarget(item)).toBe("mode-switch")

    const select = document.createElement("select")
    expect(soundEffectForTarget(select)).toBe("mode-switch")
  })

  it("honours an explicit data-sound-effect override", () => {
    const button = document.createElement("button")
    button.dataset.soundEffect = "confirm"
    expect(soundEffectForTarget(button)).toBe("confirm")

    const silent = document.createElement("button")
    silent.dataset.soundEffect = "none"
    expect(soundEffectForTarget(silent)).toBeUndefined()
  })

  it("ignores non-interactive targets", () => {
    const paragraph = document.createElement("p")
    paragraph.textContent = "plain text"
    expect(soundEffectForTarget(paragraph)).toBeUndefined()
    expect(soundEffectForTarget(null)).toBeUndefined()
  })
})

describe("sound effect events", () => {
  afterEach(() => resetSoundEffectsForTests())

  it("deduplicates repeated status updates per session", async () => {
    const play = vi.spyOn(await import("./sound-engine"), "playSound")
    publishSoundEffectsEnabled(true)

    handleSoundEffectEvent({ kind: "status", eventID: "e1", sessionID: "ses_1", status: "running" })
    handleSoundEffectEvent({ kind: "status", eventID: "e2", sessionID: "ses_1", status: "running" })
    handleSoundEffectEvent({ kind: "status", eventID: "e3", sessionID: "ses_1", status: "idle" })
    handleSoundEffectEvent({ kind: "status", eventID: "e4", sessionID: "ses_1", status: "idle" })

    expect(play).toHaveBeenCalledTimes(2)
    expect(play).toHaveBeenNthCalledWith(1, "agent-start")
    expect(play).toHaveBeenNthCalledWith(2, "agent-end")
  })

  it("plays an error sound for retry transitions", async () => {
    const play = vi.spyOn(await import("./sound-engine"), "playSound")
    publishSoundEffectsEnabled(true)

    handleSoundEffectEvent({ kind: "status", eventID: "e1", sessionID: "ses_2", status: "retry" })
    expect(play).toHaveBeenCalledWith("error")
  })

  it("suppresses the blackboard sound right after the user posts", async () => {
    const play = vi.spyOn(await import("./sound-engine"), "playSound")
    publishSoundEffectsEnabled(true)
    suppressNextBlackboardSound()

    handleSoundEffectEvent({ kind: "blackboard", eventID: "e1" })
    expect(play).not.toHaveBeenCalled()
  })

  it("plays attention sounds for permission and question requests", async () => {
    const play = vi.spyOn(await import("./sound-engine"), "playSound")
    publishSoundEffectsEnabled(true)

    handleSoundEffectEvent({ kind: "attention", eventID: "e1" })
    expect(play).toHaveBeenCalledWith("attention")
  })

  it("throttles typing ticks to one sound per window", async () => {
    const play = vi.spyOn(await import("./sound-engine"), "playSound")
    publishSoundEffectsEnabled(true)

    handleSoundEffectEvent({ kind: "typing", eventID: "e1" })
    handleSoundEffectEvent({ kind: "typing", eventID: "e2" })
    handleSoundEffectEvent({ kind: "typing", eventID: "e3" })

    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledWith("typing")
  })
})
