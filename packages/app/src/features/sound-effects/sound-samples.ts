import typewriter1 from "../../assets/sounds/typewriter-1.wav?url"
import typewriter2 from "../../assets/sounds/typewriter-2.wav?url"
import typewriter3 from "../../assets/sounds/typewriter-3.wav?url"
import mouseDown from "../../assets/sounds/mouse-down.wav?url"
import mouseUp from "../../assets/sounds/mouse-up.wav?url"
import switchOn from "../../assets/sounds/switch-on.wav?url"
import switchOff from "../../assets/sounds/switch-off.wav?url"
import latch from "../../assets/sounds/latch.wav?url"
import paperSlide from "../../assets/sounds/paper-slide.wav?url"
import paperTurn from "../../assets/sounds/paper-turn.wav?url"
import paperCrumple from "../../assets/sounds/paper-crumple.wav?url"
import bell from "../../assets/sounds/bell.wav?url"
import glass from "../../assets/sounds/glass-tap.wav?url"
import wood from "../../assets/sounds/wood-tap.wav?url"
import levels from "../../assets/sounds/levels.json"

export type SoundSample = { url: string; volume: number; delay?: number }
const sample = (url: string, volume = 0.95, delay = 0): SoundSample => ({ url, volume, delay })
// Each outer entry is a variation; each inner entry is a short recorded sequence.
// Recordings share one loudness target. Completion uses a real bell.
export const rawSoundSamples = {
  click: [[sample(mouseDown)], [sample(mouseUp)]],
  "toggle-on": [[sample(switchOn)]],
  "toggle-off": [[sample(switchOff)]],
  send: [[sample(typewriter2), sample(paperSlide, 0.95, 0.07)]],
  typing: [[sample(typewriter1)], [sample(typewriter3)], [sample(typewriter2)]],
  "agent-start": [[sample(latch)]],
  "agent-end": [[sample(glass)]],
  "goal-start": [[sample(switchOn), sample(paperSlide, 0.95, 0.08)]],
  "goal-end": [[sample(bell)]],
  error: [[sample(wood), sample(wood, 0.95, 0.13)]],
  attention: [[sample(glass), sample(glass, 0.95, 0.18)]],
  blackboard: [[sample(paperTurn)]],
  "panel-open": [[sample(paperSlide)]],
  "panel-close": [[sample(paperTurn)]],
  "mode-switch": [[sample(switchOn)]],
  confirm: [[sample(latch), sample(glass, 0.95, 0.08)]],
  cancel: [[sample(switchOff)]],
  copy: [[sample(mouseDown), sample(paperSlide, 0.95, 0.05)]],
  attach: [[sample(paperTurn), sample(latch, 0.95, 0.08)]],
  stop: [[sample(wood)]],
  "queue-add": [[sample(typewriter3), sample(mouseUp, 0.95, 0.06)]],
  delete: [[sample(paperCrumple)]],
} satisfies Record<string, SoundSample[][]>

// Calibrated after mixing each sequence, so layered events and short clicks
// have the same measured loudness as a single paper turn or completion bell.
function hasCalibration(name: string): name is keyof typeof levels {
  return Object.hasOwn(levels, name)
}
export const soundSamples = { ...rawSoundSamples }
for (const [name, variants] of Object.entries(rawSoundSamples)) {
  if (!hasCalibration(name)) throw new Error(`Missing sound calibration: ${name}`)
  soundSamples[name] = variants.map((sequence, index) => {
    const calibration = levels[name][index]
    if (!calibration) throw new Error(`Missing sound variation calibration: ${name}/${index}`)
    return sequence.map((sample) => ({ ...sample, volume: sample.volume * calibration.gain }))
  })
}
