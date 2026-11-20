# Third-party assets and licences

| Component | How it is used | Licence |
|---|---|---|
| **Inter / Inter Display** fonts (`assets/fonts/*.otf`) | Bundled; scene graphics, thumbnails and burned-in captions | SIL Open Font License 1.1 — see `assets/fonts/OFL.txt` |
| **Lucide icons** (`lucide-static`, npm dependency) | Icons inlined into scene graphics | ISC |
| **Kokoro-82M v1.0** ONNX weights + voice packs | Downloaded by `avf models download` from the kokoro-onnx GitHub releases; not stored in this repo | Apache-2.0 (hexgrad/Kokoro-82M) |
| **phonemizer** (npm dependency) | Text → phonemes for Kokoro, runs espeak-ng compiled to WebAssembly | Wrapper Apache-2.0; bundles **espeak-ng (GPL-3.0)**. It is an unmodified npm dependency, not vendored here — review GPL obligations if you redistribute a bundled binary/image. |
| **onnxruntime-node** | Kokoro inference | MIT |
| **Playwright / Chromium** | HTML → PNG rendering | Apache-2.0 / BSD |
| **ffmpeg** | Rendering (system binary, not bundled) | LGPL/GPL depending on build |
| Background music | Synthesized at render time by `src/render/music.ts` (additive synthesis, no samples) | Part of this project (MIT); no third-party rights |

Phoneme post-processing rules in `src/tts/kokoro/phonemes.ts` follow kokoro-js (Apache-2.0).
Pexels photos (if you enable the provider) are free to use under the Pexels licence; photographer credits are recorded in each job manifest and appended to the YouTube description.
