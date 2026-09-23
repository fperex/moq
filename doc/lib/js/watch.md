---
title: "@moq/watch"
description: Subscribe, decode, and render broadcasts in the browser
---

# @moq/watch

[![npm](https://img.shields.io/npm/v/@moq/watch)](https://www.npmjs.com/package/@moq/watch)

A player: subscribes to a broadcast, picks renditions, decodes with
WebCodecs, renders video to a canvas and audio through WebAudio, and keeps them
in sync at the latency you ask for.

```html
<script type="module">
    import "@moq/watch/element";
    import "@moq/watch/ui";       // optional overlay
</script>

<moq-watch-ui>
    <moq-watch url="https://relay.example.com/anon" name="room/alice.hang">
        <canvas></canvas>
    </moq-watch>
</moq-watch-ui>
```

## Attributes

| Attribute | |
| --- | --- |
| `url`, `name` | Relay URL (with `?jwt=` if needed) and broadcast name. |
| `paused`, `muted`, `volume` | The usual player controls, mirrored as reactive properties. |
| `delay` | How far playback trails the live edge: `"auto"` (the default, sized from how late frames actually arrive), a duration like `"300ms"` which is the whole delay, or `"instant"` to paint frames as they decode with no pacing at all. |
| `buffer` | Future-dated media held beyond the live edge before playback skips ahead, e.g. `"30s"`. Defaults to none. |
| `conceal` | Cover a gap in the audio with synthesized audio instead of playing it as a gap (default on). `conceal="false"` leaves the loss audible, for a listener who would rather hear it than hear invented audio. Read when the audio graph is built. |
| `captions` | The caption track to show, or absent for off. `el.text.out.available` lists the renditions for a picker. |
| `visible` | Only subscribe to video while the element is on screen: a margin (`"20%"` default, `"200px"`), `"always"`, or `"never"`. |
| `announced` | Wait for the broadcast to be announced before subscribing (default on), so a player can be mounted before the stream exists. |
| `catalog-format` | `hang` (default, from the `.hang` suffix), `hangz` (compressed), `msf`, or `manual` to supply the catalog yourself. |

The overlay adds play/pause, volume, fullscreen, a quality selector, a
buffering indicator, an unsupported-codec warning, and a stats panel.
The stats panel counts rendered frames, so its frame-rate graph shows zero
when the displayed picture stops advancing.
`<moq-watch-support>` shows what the browser can play.

## Binding from a framework

`import "@moq/watch/element"` registers `<moq-watch>` while the module
evaluates, so a browser-only entrypoint that imports it before mounting gets an
upgraded element. `el.broadcast`, `el.video`, `el.audio`, `el.sync`, and
`el.signals` are assigned by the constructor and readable right away.

Defer the import and that guarantee goes with it. A dynamic `import()` inside
`onMount`, one behind a `browser` guard, or a `<script>` that loads after the
markup all leave the tag unregistered until they land, and an element of an
unregistered tag is a plain `HTMLElement`. A framework binding
(Svelte's `bind:this`, React's `ref`) hands you that un-upgraded node, where
every property reads `undefined`:

```ts
// TypeError: el.broadcast is undefined
el.broadcast.out.catalog.subscribe(handler);
```

The browser upgrades the same node once the definition arrives, applying the
attributes it already has. Use a static import in browser-only entrypoints.
For SSR applications, run the following in a client-side mount hook, after
the node exists. The element module needs browser globals and must not be
imported during server rendering. Start the import before waiting for registration:

```ts
await import("@moq/watch/element");
await customElements.whenDefined("moq-watch");
el.broadcast.out.catalog.subscribe(handler);
```

## Custom tracks

The catalog schema is loose: sections `@moq/hang` doesn't recognize are passed
through to `broadcast.out.catalog`, a read-only signal you react to like any
other. Subscribe to the track it names off `broadcast.out.active`, the live
broadcast consumer, and decode JSON with
[`@moq/json`](https://www.npmjs.com/package/@moq/json).

```ts
import * as Json from "@moq/json";
import { Hang } from "@moq/watch";

// Run after the element module has loaded and the node has mounted.
const el = document.querySelector("moq-watch");
if (!el) throw new Error("Missing <moq-watch> element");

const dispose = el.signals.run((effect) => {
    const catalog = effect.get(el.broadcast.out.catalog) as { metadata?: unknown } | undefined;
    const active = effect.get(el.broadcast.out.active);

    const metadata = catalog?.metadata;
    if (metadata !== undefined &&
        (!Array.isArray(metadata) || !metadata.every((name): name is string => typeof name === "string"))) {
        throw new Error("Expected metadata to be an array of track names");
    }
    const name = metadata?.[0];
    if (!active || !name) return;

    const track = active.track(name).subscribe({ priority: Hang.Catalog.PRIORITY.catalog });
    effect.cleanup(() => track.close());

    const consumer = new Json.Snapshot.Consumer<unknown>({ track });
    effect.spawn(async () => {
        for (;;) {
            const value = await Promise.race([effect.cancel, consumer.next()]);
            if (value === undefined) break;
            console.log("metadata", value);
        }
    });
});
```

Call `dispose()` from your framework's unmount cleanup when this subscription
is no longer needed. Removing the element disables playback but keeps its
effects open so the same node can reconnect.

The effect re-runs whenever the catalog or the active broadcast changes, so a
reconnect resubscribes on its own. A publisher that rewrites its catalog often
(a live encoder tweak) re-runs it too; memoize the track name with
`effect.computed` when that matters, as the
[watch demo](https://github.com/moq-dev/moq/blob/main/demo/web/src/index.ts)
does.

`el.catalog` is the same value read once, without subscribing. Reach the rest
of the pipeline through `el.broadcast`, `el.video`, `el.audio`, and
`el.signals`.

## Without the element

```ts
import * as Moq from "@moq/net";
import * as Watch from "@moq/watch";

// Shared with every other component pointed at the same relay; the broadcast
// handle reads from its origin and spans reconnects.
const connection = new Moq.Connection({ url: new URL("https://relay.example.com/anon") });
const player = new Watch.Player({
    origin: connection.origin,
    probe: connection.probe,
    name: Moq.Path.from("alice.hang"),
    canvas,
});
// player.broadcast, player.video, player.audio, player.text, player.sync,
// player.renderer, and player.emitter expose the pipeline.
// Call player.close() when playback ends.
```

Pass a signal from [`@moq/signals`](/lib/js/signals) for any control you want
to change later, such as `muted` or `delay`. `Player` owns the same pipeline as
`<moq-watch>`; `Watch.Broadcast`, `Sync`, and the per-track components remain
available for custom composition. Load the element from a CDN
(`https://esm.sh/@moq/watch/element`) for a no-build embed.

## Keeping tracks together

`Watch.Sync` is the clock the tracks render against. It takes the playback
settings, `delay` and `buffer`, and nothing else; each track is wired through a
handle of its own:

```ts
const sync = new Watch.Sync({ delay: "auto" });

const audio = sync.track("audio");
audio.spread; // how late its frames actually arrived
```

`"auto"` is that measurement, the largest across every track;
`sync.track("text")` joins on the same footing. What the selected rendition
says it flushes at once is not a second term: it is the same quantity measured
by the publisher, so it is where the measurement starts (the container
consumer's `jitter`) and the arrivals take it from there, up or down. A fixed
`delay` is exactly the number asked for, with nothing added to it.

While audio plays, its ring publishes where it is (`audio.clock`) and
everything else is paced against that: `sync.wait()` for video frames,
`sync.now()` for captions. A ring that re-buffers parks its playhead, and
video parks with it instead of running away from the audio you can hear. Mute
the player or end the track and the clock is handed back to the wall clock
where the playhead left it, so nothing jumps. `sync.out.clock` names whichever
track is driving, or is empty while playback runs on wall time.

## Converging on the delay

The audio ring is almost never exactly on its target: a publisher that flushes
several frames at once fills it in steps, the network moves the arrivals around,
and the target itself follows what arrives. Rather than jump, the ring plays the
media very slightly faster or slower until it is back where it belongs, the way
WebRTC's NetEq does. Each correction drops or repeats one pitch period, at most
15ms per 100ms of audio and only where the waveform repeats, so convergence is
inaudible.

Skipping ahead is left for what the stretch cannot close in half a second.
`audio.out.underruns` counts the times the ring ran dry, and the stats panel
shows the corrections beside it: `Stretch` counts the blocks played fast and then
the blocks played slow, and `Skipped` what was thrown away. A healthy stream
shows corrections and no skips; skips mean the delay is moving faster than the
stretch can follow.

## Covering what never arrived

A stretch bends a few percent, so it cannot cover a packet that is a whole
hundred milliseconds late or a group the network gave up on. Rather than play the
hole as silence, the player carries the audio on: it takes the pitch period of
the last real audio, repeats it, and fades it out if the outage runs on, the way
WebRTC's NetEq conceals one. When the media comes back it is lined up against the
concealment and crossfaded in, so neither end of the outage is a click. The fade
ends in digital silence rather than in room tone, which is what the pinned
Chromium tree does and what tells a paused talker apart from a dead stream; a
publisher that means to pause says so on the wire instead, and the player renders
that as silence with no concealment at all.

The stats panel's `Concealed` row is how much audio was invented and how many
separate outages that covered. Turn it off with `conceal` on the audio decoder
and a gap is a gap again, audibly:

```ts
new Watch.Audio.Decoder(source, sync, { conceal: false });
```

It is read when the audio graph is built, since it belongs to the reader inside
the worklet.

## Buffered playback

By default the player minimizes latency: it skips ahead whenever media piles
up past the delay. Content produced faster than real time, such as a TTS
response emitted in one burst with future timestamps, wants the opposite. Set
`buffer` to how far ahead it may run and it plays through at the encoded pace:

```html
<moq-watch url="..." name="bot/tts.hang" delay="100ms" buffer="30s"></moq-watch>
```

Durations need a unit; a bare number is rejected. Only the delay is held as
decoded PCM; the buffer stays as encoded frames with backpressure on the
decoder, so a large one is cheap. `el.reset()` flushes and re-anchors at the
next frame, which is how a producer interrupts an utterance.
