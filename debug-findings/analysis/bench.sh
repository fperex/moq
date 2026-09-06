#!/bin/bash
# Phase B benchmark matrix for one variant. Usage: bench.sh <variant-name> "<rt flags, e.g. f2,f3>" [quick]
# Runs, with the exact embedding page (&embed=1) and the black-box probe:
#   local native bbb (fmp4) on both rings: auto/100ms/250ms/500ms (60 s)
#   local TS import, default PES packing, postMessage ring: auto/500ms (60 s)
#   public bbb, postMessage ring (production path): auto/100ms/250ms/500ms (60 s)
#   own publisher (real mic) over the public relay, shared ring: auto/500ms (45 s)
# Safari and the replay sweep are run separately. Results: debug-findings/runs/<variant>-*.
set -u
V=$1; FLAGS=${2:-}; QUICK=${3:-}
# Paths resolve from this checkout; MOQ_BIN_DIR points at a cargo target dir holding moq and moq-relay.
REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
A=$REPO/debug-findings/analysis
R=$REPO/debug-findings/runs
BIN=${MOQ_BIN_DIR:-$REPO/target/debug}
RB=$BIN/moq-relay
MOQ=$BIN/moq
BBB=$REPO/demo/pub/media/bbb.mp4
RC=$REPO/demo/relay
EXTRA="&embed=1${FLAGS:+&rt=$FLAGS}"
HOLD=60; [ -n "$QUICK" ] && HOLD=30
run() { tag=$1; shift; bun "$A/run.mjs" --tag="$V-$tag" --cdp=9225 --inject=1 --watchExtra="$EXTRA" "$@" > "$R/$V-$tag.driver.log" 2>&1; echo "$V-$tag exit=$?"; sleep 3; }
CMAF="ffmpeg -hide_banner -v quiet -stream_loop -1 -re -i $BBB -c copy -f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer+frag_every_frame - | $MOQ --connect http://localhost:4443 --broadcast bbb.hang import fmp4"
TSD="ffmpeg -hide_banner -v quiet -stream_loop -1 -re -i $BBB -c copy -f mpegts - | $MOQ --connect http://localhost:4443 --broadcast bbb.hang import ts"
run local-fmp4-iso  --vite=5174 --relay=http://localhost:4443 --name=bbb.hang --publisher=cmd --pubCmd="$CMAF" --pubWarm=6 --presets=auto,100ms,250ms,500ms --hold=$HOLD --relayBin=$RB --relayCwd="$RC" --relayWarm=2
run local-fmp4-post --vite=5175 --relay=http://localhost:4443 --name=bbb.hang --publisher=cmd --pubCmd="$CMAF" --pubWarm=6 --presets=auto,100ms,250ms,500ms --hold=$HOLD --relayBin=$RB --relayCwd="$RC" --relayWarm=2
run local-ts-post   --vite=5175 --relay=http://localhost:4443 --name=bbb.hang --publisher=cmd --pubCmd="$TSD" --pubWarm=6 --presets=auto,500ms --hold=$HOLD --relayBin=$RB --relayCwd="$RC" --relayWarm=2
run remote-post     --vite=5175 --relay=https://cdn.moq.pro/demo --name=bbb.hang --publisher=none --presets=auto,100ms,250ms,500ms --hold=$HOLD
run ownpub-remote   --vite=5174 --relay=https://cdn.moq.dev/anon --name="rt/$V.hang" --publisher=harness --focus=watch --presets=auto,500ms --hold=45
echo "BENCH-DONE $V"
