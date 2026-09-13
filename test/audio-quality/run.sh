#!/usr/bin/env bash
# Plays a broadcast in a headless browser over a seeded, impaired path, and records what it heard.
#
# One row of the matrix is one page playing one codec through one shaper profile on one ring, for
# --duration seconds. The numbers that come out are the listener's: how often the ring ran dry, how
# much of the run was silent, how far the playhead jumped, and where the delay settled.
#
# Three things make a row trustworthy, and each one voids the row rather than quietly passing it:
#
#   - The impairment applied. The shaper counts what it delayed, and a profile that treated nothing
#     turns an impaired run into an unimpaired pass.
#   - The transport was WebTransport. A WebSocket fallback is TCP and never touches the UDP shaper.
#   - The ring that ran is the one the row asked for, which is decided by whether the document is
#     cross-origin isolated, not by anything the page can assert about itself.
#
# Budgets are recorded here, not enforced: see README.md and grade.ts. Pass --enforce to fail on them.
set -euo pipefail

AQ_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORKSPACE=$(cd "$AQ_DIR/../.." && pwd)
CLIENT="$AQ_DIR/clients/js"

# Run directory, reserved ports, and process-group ownership. See test/README.md.
# shellcheck source-path=SCRIPTDIR source=../lib/harness.sh
source "$AQ_DIR/../lib/harness.sh"

# Captured before the parse below consumes it, so the rerun command carries every flag and every
# environment override this run was actually given.
RERUN="$(harness_env AQ_PROFILE RELAY_BIN)just test audio-quality$(harness_argv "$@")"

# Every profile the matrix knows. `fixed-250` is the control: the path is left alone and the page
# runs a fixed 250ms preset instead of adapting, because a fixed preset is what a viewer lands on
# today and the rest of the matrix would otherwise pass while it regressed.
ALL_PROFILES=(near-zero mild bursty step high-rtt fixed-250)
# Safari has no WebTransport to impair. `@moq/net` refuses it on every WebKit engine, so a Safari
# session is a WebSocket, which is TCP, which the shaper passes through untouched. Rather than
# labelling an unimpaired run `bursty`, this runtime offers only the two profiles whose path
# treatment is already nothing, and its rows record `shaper: none`.
SAFARI_PROFILES=(near-zero fixed-250)
# The replay runtime's "profile" is which recording was replayed: the path is what it did on the day
# it was captured, not something a shaper applied. `replay.ts` owns what each one was recorded off.
REPLAY_PROFILES=(lan-bbb relay-bbb-7frame 4k-webm)
ALL_RINGS=(isolated plain)
ALL_CODECS=(opus aac)
ALL_RUNTIMES=(chromium safari replay)

RUNTIME=chromium
PROFILES=()
RINGS=("${ALL_RINGS[@]}")
CODECS=("${ALL_CODECS[@]}")
CODECS_SET=0
DURATION=60
DURATION_SET=0
SEED=7
SEED_SET=0
OUT=""
LIST=0
ENFORCE=0
PROFILE="${AQ_PROFILE:-debug}"

split() {
    local IFS=,
    # shellcheck disable=SC2206  # splitting on commas is the point
    SPLIT=($1)
}

need() {
    if [[ $2 -lt 2 || -z "${3:-}" || "${3:-}" == -* ]]; then
        echo "error: $1 requires a value" >&2
        exit 2
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --profiles)
            need "$1" $# "${2:-}"
            split "$2"
            PROFILES=("${SPLIT[@]}")
            shift 2
            ;;
        --rings)
            need "$1" $# "${2:-}"
            split "$2"
            RINGS=("${SPLIT[@]}")
            shift 2
            ;;
        --codecs)
            need "$1" $# "${2:-}"
            split "$2"
            CODECS=("${SPLIT[@]}")
            CODECS_SET=1
            shift 2
            ;;
        --runtime)
            need "$1" $# "${2:-}"
            RUNTIME="$2"
            shift 2
            ;;
        --duration)
            need "$1" $# "${2:-}"
            DURATION="$2"
            DURATION_SET=1
            shift 2
            ;;
        --seed)
            need "$1" $# "${2:-}"
            SEED="$2"
            SEED_SET=1
            shift 2
            ;;
        --out)
            need "$1" $# "${2:-}"
            OUT="$2"
            shift 2
            ;;
        --list)
            LIST=1
            shift
            ;;
        --enforce)
            ENFORCE=1
            shift
            ;;
        *)
            echo "unknown arg: $1" >&2
            exit 2
            ;;
    esac
done

if [[ ! "$DURATION" =~ ^[0-9]+(\.[0-9]+)?$ ]] || [[ "$DURATION" =~ ^0+(\.0+)?$ ]]; then
    echo "error: --duration must be a positive number (got '$DURATION')" >&2
    exit 2
fi
if [[ ! "$SEED" =~ ^[0-9]+$ ]]; then
    echo "error: --seed must be a non-negative integer (got '$SEED')" >&2
    exit 2
fi

valid() {
    local want="$1" name="$2"
    shift 2
    local known
    for known in "$@"; do
        [[ "$known" == "$want" ]] && return 0
    done
    echo "error: unknown $name '$want' (known: $*)" >&2
    exit 2
}
valid "$RUNTIME" runtime "${ALL_RUNTIMES[@]}"

# The runtime decides which profiles exist, so the default is resolved after it is known and an
# explicit list is checked against that runtime's set rather than against every name the file knows.
KNOWN_PROFILES=("${ALL_PROFILES[@]}")
[[ "$RUNTIME" != safari ]] || KNOWN_PROFILES=("${SAFARI_PROFILES[@]}")
[[ "$RUNTIME" != replay ]] || KNOWN_PROFILES=("${REPLAY_PROFILES[@]}")
[[ ${#PROFILES[@]} -gt 0 ]] || PROFILES=("${KNOWN_PROFILES[@]}")

for p in "${PROFILES[@]}"; do valid "$p" profile "${KNOWN_PROFILES[@]}"; done
for r in "${RINGS[@]}"; do valid "$r" ring "${ALL_RINGS[@]}"; done
for c in "${CODECS[@]}"; do valid "$c" codec "${ALL_CODECS[@]}"; done

if [[ "$RUNTIME" == safari && "$(uname -s)" != Darwin ]]; then
    echo "error: the safari runtime needs safaridriver, which is macOS only" >&2
    exit 2
fi

# A replay row's codec, rate, and length come from the recording, and its impairment is whatever the
# path did on the day it was captured. A flag that says otherwise would be silently ignored, so it is
# refused instead.
if [[ "$RUNTIME" == replay ]]; then
    for flag in "--codecs:$CODECS_SET" "--duration:$DURATION_SET" "--seed:$SEED_SET"; do
        [[ "${flag#*:}" -eq 0 ]] || {
            echo "error: ${flag%:*} means nothing to the replay runtime: the recording decides it" >&2
            exit 2
        }
    done
fi

# `step` exists to move the path part-way through a run, so a run that ends before the step measures
# a steady profile under the step's name and passes on numbers that mean something else. Refuse it
# rather than record it. The step time comes from the profile itself, so shortening it there is
# enough; there is no second copy here to forget.
for p in "${PROFILES[@]}"; do
    [[ "$p" == step ]] || continue
    # Read inside the branch, and tolerate the read failing, so an unreadable profile file stops the
    # one run that depends on it with the message below rather than killing every other run under
    # `set -e` before that message can be printed.
    STEP_AT=$(sed -n 's/^at = "\([0-9]*\)s"/\1/p' "$WORKSPACE/rs/moq-shaper/profiles/step.toml" 2>/dev/null | head -1 || true)
    if [[ -z "$STEP_AT" ]]; then
        echo "error: could not read the step time from rs/moq-shaper/profiles/step.toml" >&2
        exit 2
    fi
    if (($(printf '%.0f' "$DURATION") <= STEP_AT)); then
        echo "error: --duration $DURATION never reaches the step profile's change at ${STEP_AT}s;" >&2
        echo "       run it longer, or drop 'step' from --profiles" >&2
        exit 2
    fi
done

# The codec's sample rate is part of the row key, because it moves the expected floor as much as the
# profile does: a 44.1kHz stream's frames do not land on the 48kHz render quantum.
rate_of() {
    case "$1" in
        opus) echo 48000 ;;
        aac) echo 44100 ;;
        *) echo "error: no rate for codec '$1'" >&2 && exit 2 ;;
    esac
}

# Every profile but the control adapts. The control runs the demo's fixed preset, which the element
# requires a unit on: `delay=250` is rejected, `delay=250ms` is not.
delay_of() {
    case "$1" in
        fixed-250) echo "250ms" ;;
        *) echo "auto" ;;
    esac
}

# `fixed-250` is a page setting, not a path treatment, so the path is left as the control.
shaper_of() {
    case "$1" in
        fixed-250) echo "near-zero" ;;
        *) echo "$1" ;;
    esac
}

# Grade what the run produced and, if asked, keep the directory it produced it in. Both lanes end
# here, so the two cannot disagree about what a run leaves behind.
finish() {
    local status="$1"
    echo ""
    local grade=(bun "$CLIENT/grade.ts" --run "$HARNESS_RUN" --budgets "$AQ_DIR/budgets.json")
    [[ $ENFORCE -eq 0 ]] || grade+=(--enforce)
    "${grade[@]}" || status=1

    # The run directory is the deliverable, not a by-product: the summaries, the shaper reports, and
    # the raw ndjson are what a before/after table is built from later.
    if [[ -n "$OUT" ]]; then
        mkdir -p "$OUT"
        cp -R "$HARNESS_RUN/." "$OUT/"
        echo ""
        echo "saved: $OUT"
    fi
    exit "$status"
}

# ── replay ──────────────────────────────────────────────────────────────────
# No relay, no shaper, no browser, no clock: the recordings go straight through the real estimator,
# the real rings, and the real playout engine on a simulated clock. `replay.ts` owns the row keys,
# because the codec and rate of each row are the recording's rather than a choice.
if [[ "$RUNTIME" == replay ]]; then
    replay_args=(--rings "$(
        IFS=,
        echo "${RINGS[*]}"
    )" --fixtures "$(
        IFS=,
        echo "${PROFILES[*]}"
    )")

    command -v bun >/dev/null 2>&1 || {
        echo "error: bun not found; run inside 'nix develop'" >&2
        exit 1
    }
    (cd "$CLIENT" && bun install --frozen-lockfile >/dev/null)

    if [[ $LIST -eq 1 ]]; then
        bun "$CLIENT/replay.ts" --list "${replay_args[@]}"
        exit 0
    fi

    harness_begin audio-quality "$RERUN"
    bun "$CLIENT/replay.ts" --out "$HARNESS_RUN" "${replay_args[@]}"
    finish 0
fi

# One entry per row: the tag, then the fields the row needs, tab separated. The tag encodes the same
# fields (the analyzer parses it back out, and it names every file the row produces), but the loop
# reads them from here rather than re-splitting a string in which two of the values contain dashes.
ROWS=()
for codec in "${CODECS[@]}"; do
    for profile in "${PROFILES[@]}"; do
        for ring in "${RINGS[@]}"; do
            printf -v entry '%s\t%s\t%s\t%s' \
                "$RUNTIME-$codec-$(rate_of "$codec")-$profile-$ring" "$codec" "$profile" "$ring"
            ROWS+=("$entry")
        done
    done
done

if [[ $LIST -eq 1 ]]; then
    printf '%s\n' "${ROWS[@]%%$'\t'*}"
    echo "" >&2
    echo "${#ROWS[@]} rows at ${DURATION}s each, seed $SEED" >&2
    exit 0
fi

harness_begin audio-quality "$RERUN"

for tool in cargo bun ffmpeg; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "error: $tool not found; run inside 'nix develop'" >&2
        exit 1
    }
done

# ── build ───────────────────────────────────────────────────────────────────
flag=()
[[ "$PROFILE" == "debug" ]] || flag=(--profile "$PROFILE")
echo "building moq-relay, moq, moq-shaper ($PROFILE)..."
(cd "$WORKSPACE" && cargo build --locked ${flag[@]+"${flag[@]}"} -p moq-relay -p moq-cli -p moq-shaper)
TARGET_BASE="${CARGO_TARGET_DIR:-$WORKSPACE/target}"
RELAY="${RELAY_BIN:-$TARGET_BASE/$PROFILE/moq-relay}"
MOQ="$TARGET_BASE/$PROFILE/moq"
SHAPER="$TARGET_BASE/$PROFILE/moq-shaper"

MEDIA="$WORKSPACE/demo/pub/media/bbb.mp4"
if [[ ! -f "$MEDIA" ]]; then
    echo "downloading bbb.mp4..."
    (cd "$WORKSPACE" && just pub download bbb)
fi

echo "building the page..."
(
    cd "$CLIENT"
    bun install --frozen-lockfile
    # Playwright drives Chromium and nothing else here; Safari comes from the OS, through safaridriver.
    [[ "$RUNTIME" == safari ]] || bunx playwright install chromium
    bunx vite build
)

# ── relay ───────────────────────────────────────────────────────────────────
harness_port relay
RELAY_PORT="$HARNESS_PORT"
RELAY_URL="http://127.0.0.1:$RELAY_PORT"
sed "s/4443/$RELAY_PORT/g" "$AQ_DIR/relay.toml" >"$HARNESS_RUN/relay.toml"
echo "starting relay on 127.0.0.1:$RELAY_PORT..."
harness_spawn relay "$HARNESS_RUN/relay.log" "$RELAY" "$HARNESS_RUN/relay.toml"
if ! harness_ready "$RELAY_URL/certificate.sha256" 30 "$HARNESS_PID"; then
    echo "relay never became ready" >&2
    sed 's/^/  relay: /' "$HARNESS_RUN/relay.log" >&2 || true
    exit 1
fi
harness_endpoint relay "$RELAY_URL"

# ── sink ────────────────────────────────────────────────────────────────────
# Only the Chromium lane posts beacons. Safari's driver drains the page's probe over WebDriver and
# writes the same ndjson itself, because safaridriver is the only channel it has back to the page.
if [[ "$RUNTIME" != safari ]]; then
    harness_port sink
    SINK_PORT="$HARNESS_PORT"
    SINK_URL="http://127.0.0.1:$SINK_PORT"
    harness_spawn sink "$HARNESS_RUN/sink.log" bun "$CLIENT/sink.ts" --dir "$HARNESS_RUN" --port "$SINK_PORT"
    if ! harness_ready "$SINK_URL/health" 15 "$HARNESS_PID"; then
        echo "sink never became ready" >&2
        sed 's/^/  sink: /' "$HARNESS_RUN/sink.log" >&2 || true
        exit 1
    fi
    harness_endpoint sink "$SINK_URL"
else
    harness_port webdriver
    DRIVER_PORT="$HARNESS_PORT"
fi

harness_port web
WEB_PORT="$HARNESS_PORT"

# ── publishers ──────────────────────────────────────────────────────────────
# The publishers talk to the relay directly. Only the browser goes through the shaper: impairing the
# ingest too would mean grading the receiver on a stream that was already damaged before it was
# published, and the publisher's own flush span is a separate stage of the ledger.
#
# Both ffmpeg invocations mirror demo/pub/justfile, with one deliberate difference each. Opus is
# encoded rather than copied, because bbb.mp4 carries AAC. The TS arm leaves ffmpeg's default PES
# packing alone (demo/pub passes `-pes_payload_size 0` for the smooth variant), because the resulting
# multi-frame bursts are the arrival shape the reporter measured on the public relay.
# shellcheck disable=SC2329  # invoked indirectly via 'harness_spawn'
publish_opus() {
    ffmpeg -hide_banner -v quiet -stream_loop -1 -re -i "$MEDIA" \
        -c:v copy -c:a libopus -ar 48000 -ac 2 -b:a 128k \
        -f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer -frag_duration 1000 - |
        "$MOQ" --connect "$RELAY_URL" --broadcast "bbb-opus.hang" import fmp4
}

# shellcheck disable=SC2329  # invoked indirectly via 'harness_spawn'
publish_aac() {
    ffmpeg -hide_banner -v quiet -stream_loop -1 -re -i "$MEDIA" \
        -c:v copy -c:a aac -ar 44100 -ac 2 -b:a 128k \
        -f mpegts - |
        "$MOQ" --connect "$RELAY_URL" --broadcast "bbb-aac.hang" import ts
}

for codec in "${CODECS[@]}"; do
    echo "starting the $codec publisher..."
    harness_spawn "pub-$codec" "$HARNESS_RUN/pub-$codec.log" "publish_$codec"
done
# A publisher needs a moment to announce before the first page asks for it; the driver's own 30s wait
# for a catalog covers the rest, and a publisher that died is reported by that wait rather than here.
sleep 3

# ── rows ────────────────────────────────────────────────────────────────────
echo ""
echo "running ${#ROWS[@]} rows at ${DURATION}s each (seed $SEED)"
failed=0

# One shaper port for the whole run: only one row plays at a time, and a reservation per row would
# walk through two dozen of them for no benefit. The Safari lane never stands one up.
if [[ "$RUNTIME" != safari ]]; then
    harness_port shaper
    shaper_port="$HARNESS_PORT"
fi

for entry in "${ROWS[@]}"; do
    IFS=$'\t' read -r tag codec profile ring <<<"$entry"

    echo ""
    echo "── $tag ──"

    shaper_pid=""
    page_url="$RELAY_URL"
    if [[ "$RUNTIME" != safari ]]; then
        harness_spawn "shaper-$tag" "$HARNESS_RUN/shaper-$tag.ndjson" \
            "$SHAPER" --listen "127.0.0.1:$shaper_port" --upstream "127.0.0.1:$RELAY_PORT" \
            --profile "$(shaper_of "$profile")" --seed "$SEED" \
            --report-interval 1s --report "$HARNESS_RUN/shaper-$tag.json"
        shaper_pid="$HARNESS_PID"
        if ! harness_ready "http://127.0.0.1:$shaper_port/certificate.sha256" 15 "$shaper_pid"; then
            echo "shaper never passed TCP through for $tag" >&2
            failed=1
            harness_reap "$shaper_pid"
            continue
        fi
        page_url="http://127.0.0.1:$shaper_port"
    fi

    status=0
    if [[ "$RUNTIME" == safari ]]; then
        # Serial by construction: Safari hosts one WebDriver session at a time, and the window it
        # opens has to stay frontmost for the AudioContext to render.
        harness_spawn "safari-$tag" - bun "$CLIENT/safari.ts" \
            --url "$page_url" \
            --broadcast "bbb-$codec.hang" \
            --page "$CLIENT/dist" \
            --port "$WEB_PORT" \
            --driver-port "$DRIVER_PORT" \
            --ring "$ring" \
            --delay "$(delay_of "$profile")" \
            --duration "$DURATION" \
            --tag "$tag" \
            --out "$HARNESS_RUN" || true
    else
        harness_spawn "driver-$tag" - bun "$CLIENT/driver.ts" \
            --url "$page_url" \
            --broadcast "bbb-$codec.hang" \
            --page "$CLIENT/dist" \
            --port "$WEB_PORT" \
            --ring "$ring" \
            --delay "$(delay_of "$profile")" \
            --duration "$DURATION" \
            --tag "$tag" \
            --sink "$SINK_URL/log" \
            --out "$HARNESS_RUN" || true
    fi
    harness_wait "$HARNESS_PID" || status=$?
    [[ $status -eq 0 ]] || failed=1

    # SIGTERM rather than the harness's SIGKILL, because the final report is written on the way out
    # and a killed shaper leaves the row with no impairment evidence at all. The interval lines in
    # the log are the fallback if it never gets there.
    if [[ -n "$shaper_pid" ]]; then
        kill -TERM -- -"$shaper_pid" 2>/dev/null || true
        harness_wait "$shaper_pid" || true
        if [[ ! -f "$HARNESS_RUN/shaper-$tag.json" ]]; then
            tail -n 1 "$HARNESS_RUN/shaper-$tag.ndjson" >"$HARNESS_RUN/shaper-$tag.json" 2>/dev/null || true
        fi
    fi

    bun "$CLIENT/analyze.ts" --run "$HARNESS_RUN" --row "$tag" >"$HARNESS_RUN/$tag.analyze.log" 2>&1 || {
        echo "analyze failed for $tag" >&2
        sed 's/^/  /' "$HARNESS_RUN/$tag.analyze.log" >&2 || true
        failed=1
    }
done

# ── grade ───────────────────────────────────────────────────────────────────
finish "$failed"
