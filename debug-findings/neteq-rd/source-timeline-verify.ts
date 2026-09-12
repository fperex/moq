import { strict as assert } from "node:assert";
import { Group, Time, Track } from "@moq/net";
import { Consumer } from "../../js/hang/src/container/consumer";
import { encodeFrame, Format } from "../../js/hang/src/container/legacy";

// Numeric timing evidence only; the synthetic payload is never audio-decoded.
const timestamps = [
	597711655, 597734875, 597758095, 597781315, 597804535, 597827755, 597874200, 597897419, 597920639, 597943859,
	597967079, 597990299, 598013519, 598036739, 598036733, 598059953, 598083173, 598106393, 598129613, 598152833,
	598176053, 598199277, 598222497, 598245717, 598268937, 598292157, 598315377, 598338597,
];
const track = new Track.Producer("synthetic-audio");
const consumer = new Consumer(track.subscribe({ maxAge: 10000 }), {
	format: new Format("audio"),
	maxAge: Time.Milli(10000),
});
const output: Array<{ timestamp: number; discontinuity: number }> = [];
try {
	for (const [sequence, timestamp] of timestamps.entries()) {
		const group = new Group.Producer(sequence);
		group.writeFrame({
			payload: encodeFrame(new Uint8Array([1]), Time.Micro(timestamp)),
			timestamp: Time.Timestamp.fromMicros(Time.Micro(timestamp)),
		});
		group.close();
		track.writeGroup(group);
		for (;;) {
			const next = await consumer.next();
			assert.ok(next, "synthetic track ended before its frame");
			if (!next.frame) continue;
			output.push({ timestamp: next.frame.timestamp, discontinuity: next.discontinuity });
			break;
		}
	}
	assert.deepEqual(
		output.map((row) => row.timestamp),
		timestamps,
	);
	const rewinds = output.filter((row, i) => i > 0 && row.discontinuity !== output[i - 1].discontinuity);
	assert.deepEqual(rewinds, [{ timestamp: 598036733, discontinuity: 1 }]);
	console.log(JSON.stringify({ case: "authored-source-overlap", frames: output.length, rewinds }));
} finally {
	consumer.close();
	track.close();
}
