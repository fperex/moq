let loading: Promise<boolean> | undefined;

/** Load the libav WebCodecs polyfill (Opus) if AudioEncoder/AudioDecoder are missing. Resolves true once available. */
export async function polyfill(): Promise<boolean> {
	if (globalThis.AudioEncoder && globalThis.AudioDecoder) {
		return true;
	}

	if (!loading) {
		console.warn("using Opus polyfill; performance may be degraded");

		// Load the polyfill and the libav variant we're using.
		// TODO build with AAC support.
		// I forked libavjs-webcodecs-polyfill to avoid Typescript errors; there's no changes otherwise.
		loading = Promise.all([
			import("@libav.js/variant-opus-af"),
			import("@kixelated/libavjs-webcodecs-polyfill"),
		]).then(async ([opus, libav]) => {
			// A browser can ship one half of the pair. The polyfill replaces only the missing half, so
			// the classes that carry the data stay native and libav is handed instances it can't read.
			if (!globalThis.AudioDecoder) {
				const decode = libav.AudioDecoder.prototype.decode;
				libav.AudioDecoder.prototype.decode = function (
					chunk: EncodedAudioChunk | InstanceType<typeof libav.EncodedAudioChunk>,
				) {
					if (chunk instanceof libav.EncodedAudioChunk) {
						decode.call(this, chunk);
						return;
					}

					const data = new Uint8Array(chunk.byteLength);
					chunk.copyTo(data);
					decode.call(
						this,
						new libav.EncodedAudioChunk({
							type: chunk.type,
							timestamp: chunk.timestamp,
							duration: chunk.duration ?? undefined,
							data,
							transfer: [data.buffer],
						}),
					);
				};
			}

			if (!globalThis.AudioEncoder) {
				const encode = libav.AudioEncoder.prototype.encode;
				libav.AudioEncoder.prototype.encode = function (
					data: AudioData | InstanceType<typeof libav.AudioData>,
				) {
					if (data instanceof libav.AudioData) {
						encode.call(this, data);
						return;
					}

					// The conversion owns its copy, so release it once the encoder has read it.
					const converted = libav.AudioData.fromNative(data);
					try {
						encode.call(this, converted);
					} finally {
						converted.close();
					}
				};
			}

			await libav.load({
				LibAV: opus,
				polyfill: true,
			});
			return true;
		});
	}
	return await loading;
}
