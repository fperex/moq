/**
 * Types each chunk so a decoder run always opens with one the decoder will accept.
 *
 * A decoder that was just configured, reset, or flushed only accepts a chunk marked `key`, and the
 * container only marks a group's first frame as one. Re-anchoring the decoder mid-group (see
 * `Supply.#reanchor`) would otherwise hand the fresh decoder a `delta` and throw `DataError`,
 * which kills the decode loop and leaves the rest of the session silent.
 *
 * Every frame of the audio codecs hang carries is independently decodable, which is what makes
 * re-anchoring on an arbitrary frame sound in the first place, and is the same claim the container
 * already makes when it marks each group's first frame a key. So the chunk that opens a run is
 * typed `key` whatever the container called it.
 */
export class Anchor {
	#required = true;

	/** Record that the decoder was configured, reset, or flushed, so its next chunk opens a run. */
	restarted(): void {
		this.#required = true;
	}

	/** Consume one frame and report the chunk type the decoder will accept it as. */
	type(keyframe: boolean): EncodedAudioChunkType {
		const required = this.#required;
		this.#required = false;
		return required || keyframe ? "key" : "delta";
	}
}
