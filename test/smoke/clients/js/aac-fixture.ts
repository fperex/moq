/** Regenerate the eight synthetic AAC-LC packets used by the decoder timestamp check. */
const encoder = Bun.spawn(
	[
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=997:sample_rate=48000:duration=0.3",
		"-ac",
		"2",
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-f",
		"adts",
		"pipe:1",
	],
	{ stdout: "pipe", stderr: "inherit" },
);
const bytes = new Uint8Array(await new Response(encoder.stdout).arrayBuffer());
if ((await encoder.exited) !== 0) throw new Error("synthetic AAC encoding failed");

const packets: number[][] = [];
let offset = 0;
while (packets.length < 8) {
	if (offset + 7 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0)
		throw new Error("missing ADTS frame header");
	const length = ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
	const header = bytes[offset + 1] & 1 ? 7 : 9;
	if (length <= header || offset + length > bytes.length) throw new Error("invalid ADTS frame length");
	packets.push(Array.from(bytes.subarray(offset + header, offset + length)));
	offset += length;
}
await Bun.write(new URL("./src/aac-packets.json", import.meta.url), `${JSON.stringify(packets)}\n`);
