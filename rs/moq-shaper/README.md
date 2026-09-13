# moq-shaper

A seeded userspace UDP shaper, so a test can put an impaired path in front of a relay.

`moq-shaper` binds one socket, forwards every datagram to an upstream address after the
profile's treatment, and forwards the replies back. A client connects to the shaper
instead of the relay and reaches it through a path with delay, jitter, loss, reorder,
bunching, and a rate limit.

## Why userspace

Kernel-real impairment (`netem` in a network namespace) is Linux only, needs
`CAP_NET_ADMIN`, and changes the host's network for everything running on it. A test
suite needs none of that: QUIC is indifferent to an extra hop, so a datagram relay that
delays and drops on its own schedule is enough, it runs unprivileged on macOS and Linux
alike, and each test owns its own instance on its own port.

This is not an HTTP interceptor or a TCP proxy. Neither can impair QUIC.

## Usage

Put the shaper between the client and the relay, and point the client at the shaper:

```bash
moq-relay --server-bind '127.0.0.1:4443' &

moq-shaper \
    --listen 127.0.0.1:4499 \
    --upstream 127.0.0.1:4443 \
    --profile bursty \
    --report-interval 1s \
    --report run/shaper.json &

ffmpeg -re -i video.mp4 -c copy -f mpegts - | \
    moq --client-connect https://127.0.0.1:4499/anon --broadcast bbb.hang import ts
```

A browser loads the page against `https://localhost:4499` the same way. The relay's
certificate is pinned by hash rather than hostname, so the port change is all that is
needed.

| Flag | What it does |
| --- | --- |
| `--listen` | The address clients connect to instead of the upstream. |
| `--upstream` | The address every datagram is forwarded to. |
| `--profile` | A built-in profile name, or a path to a profile TOML file. |
| `--seed` | Override the profile's seed, so a failing run can be replayed. |
| `--report` | Write the final counters to this file as JSON on SIGINT or SIGTERM. |
| `--report-interval` | Print one JSON line of counters to stdout this often. |
| `--tcp-passthrough` | Proxy TCP on the listen port too. Defaults to true. |

Logs go to stderr, so stdout carries nothing but report lines.

## What a seed does and does not fix

One generator per direction is seeded from the profile, and every datagram draws from it
in the same order whether or not the knob is on: loss, then jitter, then reorder. Replay
a run with the same seed and the same datagrams are dropped, the same ones are held back,
and each one is given the same delay.

The seed does not make the kernel's delivery clock reproducible. How far a held datagram
actually slips past its neighbours, and how many are waiting at once, is the host's
scheduling. So `--seed` reproduces the decisions, and a test asserting on a replay should
assert on those rather than on arrival timestamps.

Delivery runs through one queue ordered by release time, with arrival order breaking
ties, drained by a single timer. Reorder is therefore always a deliberate act, an extra
`reorder_delay` on a datagram the generator picked, never a scheduler artifact.

## Jitter does not reorder

Jitter is queueing delay on a FIFO path, so each direction is a queue: a datagram leaves
no earlier than the one in front of it. The draw stretches and compresses the spacing
between arrivals, which is what a jittery path does, and never moves one past another.
Only `reorder` does that, and it counts itself.

This is not a detail. A shaper whose jitter overtakes hands QUIC a gap it can only read
as loss, so the connection retransmits and backs off, and the run measures congestion
response rather than the profile. On `mild` (5ms delay, 5ms sigma) that alone dragged a
receiver's audio buffer from 120ms to nearly two seconds.

## Why TCP is not impaired

A relay serves `/certificate.sha256` over HTTP on the same port number it serves QUIC on,
and a browser fetches that before it opens WebTransport. Without a TCP listener on the
shaper's port the page never loads and there is nothing to measure. So TCP is pumped
straight through, both ways, untouched: a reliable transport cannot shed load during
congestion, so shaping it would only measure how TCP retransmits. Pass
`--tcp-passthrough=false` to drop it, for a test that drives QUIC directly.

## Profiles

A profile names both directions' treatment plus the seed. `up` is the client to the
upstream, `down` is the way back. Every field is optional and defaults to off.

```toml
name = "example"
seed = 7

[up]
delay = "5ms"            # added to every datagram
jitter = "5ms"           # sigma of a gaussian on top; never negative, never reorders
loss = 0.02              # fraction discarded
reorder = 0.01           # fraction pushed back by reorder_delay, the only thing that reorders
reorder_delay = "20ms"

[up.burst]               # hold up to `count`, or until `window`, then release together
count = 7
window = "160ms"

[up.rate]                # a token bucket
bytes_per_second = 750000
burst_bytes = 30000

[up.step]                # replace delay and jitter part-way through the run
at = "30s"
delay = "60ms"
jitter = "0ms"

[down]
delay = "5ms"
```

The built-ins live in `profiles/` and are embedded in the binary, so `--profile mild`
works with no data files:

| Name | What it models |
| --- | --- |
| `near-zero` | The control. The shaper is in the path but treats nothing. |
| `mild` | A healthy wired LAN: 5ms delay, 5ms sigma. |
| `bursty` | A paced hop: seven datagrams per 160ms window, released together. |
| `step` | 5ms for thirty seconds, then 60ms. |
| `high-rtt` | An intercontinental path: 75ms one way, 30ms sigma. |
| `lossy` | The drill profile: 2% loss with 1% reorder. |

## Counters

Both `--report` and `--report-interval` emit the same object: the profile name, the seed,
and one set of counters per direction.

| Counter | Meaning |
| --- | --- |
| `delivered` | Datagrams forwarded to the far side. |
| `dropped` | Datagrams discarded, by the loss draw or by a failed send. |
| `delayed` | Datagrams released later than they arrived. |
| `reordered` | Datagrams pushed back by the extra reorder delay. |
| `rate_limited` | Datagrams the token bucket pushed back. |
| `queue_max` | The most datagrams waiting for release at once. |

## Assert the impairment applied

A profile that silently did nothing turns an impaired run into an unimpaired pass, which
is worse than no impaired lane at all. So a harness grades the shaper's counters before
it grades the run: a row on an active profile whose `delayed` is zero did not apply its
impairment and is void, and so is a lossy row whose `dropped` is zero. `near-zero` is the
only profile for which zero is the right answer, which is what makes it the control.

Record the profile name, the seed, and the counters with the run's artifacts. The seed is
what turns a failing run into one that can be looked at again.
