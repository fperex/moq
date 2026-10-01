#!/usr/bin/env bash
# The audio encoder is shared by the live publisher and the offline silence reference.
audio_of() {
    case "$1" in
        opus) echo "-c:a libopus -ar 48000 -ac 2 -b:a 128k" ;;
        aac) echo "-c:a aac -ar 44100 -ac 2 -b:a 128k" ;;
        *) echo "error: no audio encode for codec '$1'" >&2 && exit 2 ;;
    esac
}

broadcast_of() {
    if [[ "$1" == aac && "$2" == fixed-250 ]]; then
        echo "bbb-aac-paced.hang"
    else
        echo "bbb-$1.hang"
    fi
}

start_publishers() {
    local publishers=() codec profile broadcast found started name
    for codec in "${CODECS[@]}"; do
        for profile in "${PROFILES[@]}"; do
            broadcast=$(broadcast_of "$codec" "$profile")
            found=0
            for started in ${publishers[@]+"${publishers[@]}"}; do
                [[ "$started" != "$broadcast" ]] || found=1
            done
            [[ $found -eq 0 ]] || continue
            publishers+=("$broadcast")
            name="pub-$codec"
            [[ "$broadcast" != bbb-aac-paced.hang ]] || name=pub-aac-paced
            echo "starting the $broadcast publisher..."
            harness_spawn "$name" "$HARNESS_RUN/$name.log" "publish_$codec" "$profile"
        done
    done
}

# shellcheck disable=SC2329  # invoked indirectly via harness_spawn
publish_opus() {
    local audio
    read -ra audio <<<"$(audio_of opus)"
    ffmpeg -hide_banner -v quiet -stream_loop -1 -re -readrate_catchup 1 -i "$MEDIA" \
        -c:v copy "${audio[@]}" \
        -f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer -frag_duration 1000 - |
        "$MOQ" --connect "$RELAY_URL" --broadcast "$(broadcast_of opus "$1")" import fmp4
}

# shellcheck disable=SC2329  # invoked indirectly via harness_spawn
publish_aac() {
    local audio mux=()
    read -ra audio <<<"$(audio_of aac)"
    # Default PES packing can hold 16 quiet AAC frames, or 372 ms. Zero mux delay flushes
    # one frame per PES even when quiet frames fit inside the mux's minimum payload size.
    [[ "$1" != fixed-250 ]] || mux=(-max_delay 0)
    ffmpeg -hide_banner -v quiet -stream_loop -1 -re -readrate_catchup 1 -i "$MEDIA" \
        -c:v copy "${audio[@]}" ${mux[@]+"${mux[@]}"} \
        -f mpegts - |
        "$MOQ" --connect "$RELAY_URL" --broadcast "$(broadcast_of aac "$1")" import ts
}
