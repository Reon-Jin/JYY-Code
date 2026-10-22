# Recorded sound samples

All included samples are CC0 1.0 (public domain dedication):
https://creativecommons.org/publicdomain/zero/1.0/

| Included files | Original files | Author / source |
| --- | --- | --- |
| typewriter-1/2/3.wav | typewriter1/2/6.wav | Cassie-OrbitGames, https://opengameart.org/content/typewriter-sounds |
| mouse-down/up.wav | mouseclick1.wav / mouserelease1.wav | Kenney Vleugels (Kenney.nl), https://opengameart.org/content/51-ui-sound-effects-buttons-switches-and-clicks |
| switch-on/off.wav | switch2/3.wav | Kenney, same UI SFX Set |
| latch.wav | click3.wav | Kenney, same UI SFX Set |
| paper-slide/turn/crumple.wav | paper_01/02/04.ogg | rubberduck, https://opengameart.org/content/100-cc0-sfx |
| bell.wav / glass-tap.wav / wood-tap.wav | bell_02.ogg / glass_01.ogg / wooden_01.ogg | rubberduck, same 100 CC0 SFX |

Downloads: https://opengameart.org/sites/default/files/UI_SFX_Set.zip and
https://opengameart.org/sites/default/files/100-CC0-SFX_0.zip;
typewriter originals are individual WAV downloads on the source page.

Processing: mono PCM16 WAV at 32 kHz; 70 Hz high-pass, leading silence below
-48 dB removed (mouse release retains its transient), 1–2 ms fade-in, at most
1 second per sample. Peak preparation to -3 dBTP followed by 4:1 compression
at -18 dB, 0.1 ms attack / 40 ms release. Switch tails below -38 dB are trimmed.
The recordings are then levelled to -20.5 LUFS, with at least 1.5 dB true-peak
headroom. Short clips are looped for 8 seconds for FFmpeg loudnorm measurement.

Every event and typing/click variation is calibrated **after** mixing its layers
and delays, using `levels.json`: -20.5 LUFS target; -1.5 dBTP ceiling. Run
`bun scripts/calibrate-sounds.ts` from packages/app after changing recordings
or event sequences (requires FFmpeg). This writes only calibration metadata
and temporary measurement files. All 25 event variations currently reach the
same target within measurement precision. The shared playback master is 0.95;
a final compressor controls simultaneous events without changing the samples.
No synthesized tones, generated noise, or external runtime audio requests.
