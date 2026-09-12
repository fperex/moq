# In-tree smoke test

Cross-language interop smoke test that builds every client from **this checkout**
and runs them against each other.

This is the in-tree companion to [moq-dev/smoke](https://github.com/moq-dev/smoke).
That repo installs each client from its public package registry (crates.io, PyPI,
npm, ...) to catch *packaging* breakage in a release. This one builds each client
from the workspace source (`cargo`, `bun`, `uv`, `cc`) to catch *interop*
regressions before anything is published. No apt/brew/npm/PyPI, and no
distribution-mechanism matrix.

It stands up a `moq-relay`, then for each publisher language publishes an H.264
broadcast and confirms every subscriber sees data flowing before the timeout.
Most subscribers check for a non-empty frame. The browser additionally verifies
WebCodecs output painted to a canvas and drives the player's pause/resume controls.
The browser publisher also sends fake microphone audio, which the browser
subscriber checks end-to-end.

`just test smoke-media` is a separate, browser-only run that asks a harder
question: is the media a viewer gets actually advancing and in sync, and does the
player survive the publication lifecycle. See [Media QA](#media-qa).

## Clients

| Client | Source under test | Built with | Roles |
|---|---|---|---|
| Rust | `rs/moq-relay` + `rs/moq-cli` | `cargo build` | publish + subscribe |
| Python | `py/moq-rs` (+ `rs/moq-ffi`, import `moq`) | `just py build` (maturin editable into `.venv`) | publish + subscribe |
| Go | `go/wrapper` (+ `rs/moq-ffi`, import `moq-go/moq`) | `go/scripts/stage.sh` (uniffi-bindgen-go) + `go build` | publish + subscribe |
| Browser | `js/watch` + `js/publish` | `vite build` + headless Chromium (Playwright) | audio/video publish + rendered playback |
| Native JS | `js/net` + `js/hang` + the npm `@moq/web-transport` polyfill | `node` (tsx) and `bun` | subscribe |
| C | `rs/libmoq` | `cargo build -p libmoq` + `cc` | subscribe |
| GStreamer | `rs/moq-gst` (`moqsrc`) | `cargo build -p moq-gst` + `gst-launch-1.0` | subscribe |

The browser, native JS, C, and GStreamer clients subscribe only by choice
(publishing media needs an encoder the native JS runtimes lack, the C client is
intentionally minimal, and `moqsink` publishing needs request-pad muxing this
client doesn't drive). Rust, Python, Go, and the browser publish.

The Go client builds against the modules `go/scripts/stage.sh` assembles from
this checkout: `moq-ffi` compiled for the host, bindings regenerated with
`uniffi-bindgen-go`, and the `go/wrapper` module wired to them by a `replace`.
That is the same staging `just go check` uses, so this cell covers the Go
wrapper end to end rather than only compiling it. A shell without
`uniffi-bindgen-go` (the nix devShell ships it) marks the cell unavailable.

The GStreamer client builds the `moqsrc` plugin from `rs/moq-gst` and points
`GST_PLUGIN_PATH` at it, then reads a broadcast with
`gst-launch-1.0 moqsrc ... ! filesink`. The plugin dynamic-links the host's
GStreamer, so this cell needs `gst-launch-1.0` + the core plugins on the system.
The `nix develop` shell ships them; a bare shell without GStreamer marks the cell
unavailable rather than failing it.

The `@moq/web-transport` polyfill is the one dependency that comes from npm rather
than this checkout: it's a prebuilt NAPI QUIC/HTTP3 addon, not part of the moq
source tree. Everything else (`@moq/net`, `@moq/hang`, ...) resolves to the
workspace packages, because the JS clients here are bun workspace members.

## Running locally

You need the workspace toolchain on `PATH` (cargo, ffmpeg, bun, uv, go,
uniffi-bindgen-go, a C compiler). `nix develop` provides all of it except
Playwright's Chromium, which
`smoke.sh` fetches on first run (`bunx playwright install chromium`).

```bash
# Default: rust publishes, rust subscribes (a fast sanity check).
just test smoke

# Full matrix: rust/python/go/browser publish; everyone subscribes.
just test smoke-full

# Pick your own axes:
just test smoke --publishers rust,python --subscribers rust,c,js-native-bun

# Negative control: no publisher, every subscriber must time out.
just test smoke-negative

# Browser-to-browser media output and lifecycle, plus its own negative controls.
just test smoke-media
```

Subscriber names: `rust`, `python`, `go`, `js` (browser), `js-native-node`,
`js-native-bun`, `c`, `gst`. Publisher names: `rust`, `python`, `go`, `js`.

A client whose source build fails fails only its own matrix cells (see
`mark_broken` in `smoke.sh`); it never aborts the rest of the run.

## Media QA

The matrix asks "did bytes arrive and did a pixel light up". That passes on a
frozen picture, on silence, and on audio a second out of step, so
`just test smoke-media` measures the media itself, browser to browser.

### Buffered PCM worklet checks

Every smoke run that builds the browser client also runs `clients/js/pcm.ts`.
This driver needs no relay. It connects the actual audio buffer and render
worklet to a second AudioWorklet that records their output. Both stereo
channels must match the input samples exactly, and output after the declared
endpoint must be zero.

The matrix covers 44.1 kHz and 48 kHz on isolated pages using SharedArrayBuffer
and non-isolated pages using transferred messages. It checks finite playback,
reset, rendition truncation, and a queue of 400 PCM commands followed by
truncation, replacement samples, and an endpoint. Two additional takeover cases
deliver the successor endpoint before its first samples, with its start before
or after the predecessor endpoint. The gapped case uses silence around the gap
to test ordering and endpoint handling without requiring concealment to reproduce
missing source audio.

The native decoder check uses eight AAC-LC packets generated from a 997 Hz
synthetic tone at 48 kHz stereo, encoded at 128 kbit/s with FFmpeg 9.0.1.
The fixture contains no recording or external media. Regenerate it from the
repository root with `bun test/smoke/clients/js/aac-fixture.ts`. The script
extracts raw AAC packets from ADTS; encoder versions may produce different
bytes, while the test checks decoded sample counts and source timestamps.

Large-frame cases submit one three-second decoded PCM block without an intermediate
wait. They verify complete playback and reset, truncation, and endpoint commands
while part of that block still awaits admission. Only samples from the active
timeline may reach the capture worklet. Both transports must respect the logical
playout capacity even when a shared FIFO allocation is larger.

The graph case renders two seconds of known stereo samples while repeatedly
connecting and disconnecting silent gain nodes. It checks that every requested
quantum contains the next samples, even if the browser exposes a stale clock.
The result includes the capture processor's observed stale-frame count; a pass
does not require that count to be nonzero. The worklet's count of samples pulled
must remain usable when the observed context clock stalls; see the Chromium
source links below.

To run these checks independently from the repository root:

```bash
cd test/smoke/clients/js
bunx vite build
bun pcm.ts
```

To isolate a failure, pass `--case`, `--rate`, or `--transport`:

```bash
bun pcm.ts --case pressure --rate 48000 --transport post
```

The driver prints one JSON result per passing cell. A mismatch reports its
channel, sample index, actual value, and expected value. Chromium and Playwright
must already be installed, as described above. The checks measure PCM emitted
by the browser graph. They do not measure physical speakers, codec quality,
network jitter, or concealment quality.

The standalone browser clock diagnostic needs no build or relay:

```bash
bun clock.ts --mode graph --seconds 10
```

It imports no MoQ code. It counts repeated `currentFrame` values and forward
jumps in real `process()` callbacks, with a static graph, graph changes, or
suspend/resume cycles (`--mode static|graph|suspend`; omit to run all three).
This is a manual diagnostic, not a pass/fail gate requiring a browser defect.
On Chromium 151.0.7922.34, a 10-second graph run recorded 342 repeated or stale
frame values in 3,750 callbacks. A suspend/resume run recorded 34 in 1,876
callbacks; the static run recorded none.

Chromium advances its context frame after rendering, then
[updates the worklet scope](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webaudio/realtime_audio_destination_handler.cc).
That [scope update](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webaudio/base_audio_context.cc)
uses a graph try-lock and skips the update when the lock is unavailable.
Its [rendering guard](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webaudio/audio_handler.cc)
uses the context clock separately. This source path is consistent with the
observed stale worklet clock during graph changes; the probe does not instrument
Chromium's internal lock state.

### Stream output and lifecycle

The publisher is a fixture, not a fake camera: a canvas painting a frame counter
as black/white blocks, and a tone stepping through a fixed frequency table. Both
are indexed off one `AudioContext` clock, so the subscriber can read the frame it
is presenting off the canvas, read the tone step off the player's own audio
graph, and compare them. **Everything measured is browser output.** Nothing here
observes a physical speaker or display; a run says the player emitted the right
samples, not that a machine played them.

Each run covers, against a real local relay:

- **capabilities** - probes every platform API the player needs, and fails
  naming what is missing rather than skipping a case.
- **cold start** - the publisher reports when it is announced and encoding, then
  a fresh page joins. No reload, unlike the matrix driver: a subscriber that
  needs a second page load is an initialization bug, not a race.
- **user gesture** - launched with no Chromium flags at all: no fake camera, no
  fake permission prompt, no autoplay override. Both pages are clicked and both
  must carry audio afterwards. The run does not assert silence beforehand:
  Chromium enforces the gate on the fixture page and has been seen not enforcing
  it on the player's, so that assertion would measure the browser.
- **pause and resume**, **unsubscribe and rejoin**, **detach and reattach**,
  **publisher stop and same-path republish**, and **late join**.

Media CI also runs pause, rejoin, and republish with the real Libav Opus decoder.
`--audio-decoder libav` removes the subscriber's four audio WebCodecs globals;
`--audio-decoder libav-mixed` removes only `AudioDecoder` and verifies that the
native encoder, audio data, and encoded chunk constructors remain unchanged.
The publisher stays native. The harness serves the installed Libav worker and
WASM sidecars beside the built browser assets, with no remote downloads.

```bash
bun media.ts --url http://localhost:4443 --audio-decoder libav --cases pause,rejoin,republish
bun media.ts --url http://localhost:4443 --audio-decoder libav-mixed --cases pause,rejoin,republish
bun media.ts --url http://localhost:4443 --audio-decoder libav --late-audio-output --cases pause,rejoin,republish
```

The last run injects callback scheduling: it retains a clone of one frame
actually decoded by each Libav instance and delivers that frame through the
original output callback after the decoder closes. It requires every stale
frame to be released without copying PCM, then measures continuing audio and
video through the usual lifecycle checks. This does not claim that the browser
naturally delivered a late callback in that run.

- **resources return to baseline** - the page wraps `WebTransport`, `WebSocket`,
  `AudioContext`, and `Worker` to count live instances, so a detach that leaks a
  session is visible rather than merely invisible.

Tolerances come from the fixture: video must present at half the fixture's 30fps
or better and never go backwards, the tone must stand 15dB above the spectrum's
median, and audio/video skew must stay within one 200ms tone step for 90% of
samples. One step is the floor set by the analyser window straddling a step
boundary and the canvas holding a frame up to one frame old.

The run ends with negative controls. Each injects a defect in the fixture and
names the assertion that has to catch it, and passes only by failing there:

| Control | Must fail |
|---|---|
| tone muted at the source | `audio tone` |
| picture frozen after the first frame | `video progress` |
| tone table shifted 800ms ahead of the picture | `audio/video sync` |
| the detached player's session never torn down | `resource baseline` |

The leaked-session control waits for an extra `AudioContext` rather than an extra
session: every player on one relay URL shares a transport, so a session count
cannot move.

Not covered yet: other browser engines (the capability probe is the groundwork),
camera/microphone permission denial, asserting the gesture gate rather than only
exercising it, and any claim about physical playback.

The relay's port is reserved for the run rather than fixed, so two checkouts can
smoke-test at once; `SMOKE_PORT` pins one instead. `MOQ_TEST_KEEP=1` keeps the run
directory and its logs. See [the harness contract](../README.md).

## Layout

```text
smoke.sh                  orchestrator: build clients, run the relay + matrix or media checks
smoke.toml                relay config (anonymous, self-signed localhost)
clients/
  python/smoke.py         publish/subscribe via py/moq-rs (import moq)
  go/main.go              publish/subscribe via go/wrapper (import moq-go/moq)
  js/                     headless-Chromium publish/subscribe via @moq/watch + @moq/publish
    driver.ts             the interop matrix's browser publisher/subscriber
    media.ts              the media output + lifecycle checks
    harness.ts            shared Playwright plumbing
    src/contract.ts       what the page and its drivers agree on, free of browser imports
    src/fixture.ts        the deterministic publisher (frame counter + stepped tone)
    src/pattern.ts        how that fixture encodes itself into the picture and the audio
    src/probe.ts          subscriber-side measurement, taken at the sinks
    src/instrument.ts     live counts of the platform resources the page holds
  js-native/subscribe.ts  subscribe via @moq/net + @moq/hang + the WebTransport polyfill
  c/subscribe.c           subscribe via rs/libmoq
```

## CI

`.github/workflows/smoke.yml` runs the full matrix nightly (and on demand, and on
PRs that touch `test/smoke/`). A red cell means a real interop break in the
current tree.
