import { expect, test } from "bun:test";
import * as Catalog from "@moq/hang/catalog";
import * as Json from "@moq/json";
import { type Group, Origin, Path, Track } from "@moq/net";
import { Effect } from "@moq/signals";
import { Broadcast } from "./broadcast.ts";

// Effects and signal writes coalesce onto microtasks, so a chain of registration -> config -> catalog
// needs a few flushes to settle.
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
async function settle(times = 5): Promise<void> {
	for (let i = 0; i < times; i++) await flush();
}

// Read the current catalog by seeding a fresh subscriber (CatalogProducer seeds each one).
async function readCatalog(broadcast: Broadcast): Promise<Catalog.Root | undefined> {
	const effect = new Effect();
	const track = new Track.Producer("catalog.json");
	broadcast.catalog.serve(track, effect);
	const catalog = await new Json.Snapshot.Consumer<Catalog.Root>({ track: track.subscribe() }).next();
	effect.close();
	return catalog;
}

const videoConfig: Catalog.VideoConfig = { codec: "avc1.640028", container: { kind: "legacy" } };
const audioConfig: Catalog.AudioConfig = {
	codec: "opus",
	sampleRate: Catalog.u53(48000),
	numberOfChannels: Catalog.u53(2),
	container: { kind: "legacy" },
};

test("folds video and audio renditions into the catalog by full track name", async () => {
	const broadcast = new Broadcast({ enabled: true, display: { width: 1920, height: 1080 }, flip: true });

	broadcast.video("video/hd").config.set(videoConfig);
	broadcast.audio("audio/data").config.set(audioConfig);
	await settle();

	const catalog = await readCatalog(broadcast);
	expect(catalog?.video?.renditions["video/hd"]?.codec).toBe("avc1.640028");
	expect(Number(catalog?.video?.display?.width)).toBe(1920);
	expect(Number(catalog?.video?.display?.height)).toBe(1080);
	expect(catalog?.video?.flip).toBe(true);
	expect(catalog?.audio?.renditions["audio/data"]?.codec).toBe("opus");

	broadcast.close();
});

test("a rendition with an undefined config is omitted from the catalog", async () => {
	const broadcast = new Broadcast({ enabled: true });

	const hd = broadcast.video("video/hd");
	const sd = broadcast.video("video/sd");
	hd.config.set(videoConfig);
	sd.config.set(videoConfig);
	await settle();

	let catalog = await readCatalog(broadcast);
	expect(Object.keys(catalog?.video?.renditions ?? {})).toEqual(["video/hd", "video/sd"]);

	// Clearing one config drops just that entry.
	sd.config.set(undefined);
	await settle();
	catalog = await readCatalog(broadcast);
	expect(Object.keys(catalog?.video?.renditions ?? {})).toEqual(["video/hd"]);

	// Clearing the last leaves no defined configs, so the whole section is deleted.
	hd.config.set(undefined);
	await settle();
	catalog = await readCatalog(broadcast);
	expect(catalog?.video).toBeUndefined();

	broadcast.close();
});

test("a duplicate track name throws across both kinds", () => {
	const broadcast = new Broadcast({ enabled: true });

	broadcast.video("video/hd");
	expect(() => broadcast.video("video/hd")).toThrow();
	// The single registry enforces uniqueness across video and audio.
	expect(() => broadcast.audio("video/hd")).toThrow();

	broadcast.close();
});

test("rendition.close() unregisters the name and drops it from the catalog", async () => {
	const broadcast = new Broadcast({ enabled: true });

	const hd = broadcast.video("video/hd");
	hd.config.set(videoConfig);
	await settle();
	expect((await readCatalog(broadcast))?.video?.renditions["video/hd"]).toBeDefined();

	hd.close();
	await settle();
	expect((await readCatalog(broadcast))?.video).toBeUndefined();

	// The name is free to register again.
	expect(() => broadcast.video("video/hd")).not.toThrow();

	broadcast.close();
});

test("serving a subscription hands the producer to the rendition and clears it when the track closes", async () => {
	const broadcast = new Broadcast({ enabled: true, origin: new Origin.Producer(), name: Path.from("test.hang") });
	await settle();

	const net = broadcast.net.peek();
	if (!net) throw new Error("expected a network producer once connected");

	const rendition = broadcast.video("video");
	const subscriber = net.subscribe("video");
	await settle();

	// The request loop accepted the subscription and handed the producer to the rendition.
	const track = rendition.track.peek();
	expect(track).toBeDefined();

	// Closing the producer (encoder error / teardown) clears the signal, with no lingering per-subscription
	// effect watching it.
	track?.close();
	await settle();
	expect(rendition.track.peek()).toBeUndefined();

	subscriber.close();
	broadcast.close();
});

test("serves the catalog through the request loop and releases the scope when the subscriber leaves", async () => {
	const broadcast = new Broadcast({ enabled: true, origin: new Origin.Producer(), name: Path.from("test.hang") });
	broadcast.video("video").config.set(videoConfig);
	await settle();

	const net = broadcast.net.peek();
	if (!net) throw new Error("expected a network producer once connected");

	// Subscribing to the catalog track drives the per-subscription serving scope.
	const subscriber = net.subscribe(Broadcast.CATALOG_TRACK);
	const catalog = await new Json.Snapshot.Consumer<Catalog.Root>({ track: subscriber }).next();
	expect(catalog?.video?.renditions.video?.codec).toBe("avc1.640028");

	// Dropping the subscriber closes the served track; the broadcast keeps running for the next viewer.
	subscriber.close();
	await settle();
	expect(broadcast.net.peek()).toBe(net);

	broadcast.close();
});

test("releases the catalog track when its last subscriber leaves", async () => {
	const broadcast = new Broadcast({ enabled: true, origin: new Origin.Producer(), name: Path.from("test.hang") });
	broadcast.video("video").config.set(videoConfig);
	await settle();

	const net = broadcast.net.peek();
	if (!net) throw new Error("expected a network producer once connected");

	// Subscribe through a consumer handle, which is what the publishing wire layer holds: repeat
	// subscriptions to a live track share one producer there.
	const front = net.consume();
	const first = front.subscribe(Broadcast.CATALOG_TRACK);
	expect(await readSnapshot(await first.recvGroup())).toBe("avc1.640028");

	// Nothing writes to a served catalog between updates, so the track has to go when its reader
	// does. Left open it stays in the broadcast's track cache, and the next subscription fans out
	// from it instead of raising a fresh request.
	first.close(new Error("remote error: 1"));
	await settle();

	const second = front.subscribe(Broadcast.CATALOG_TRACK);
	const reseeded = await second.recvGroup();
	expect(reseeded?.sequence).toBe(1);

	second.close();
	front.close();
	broadcast.close();
});

test("seeds a later catalog subscriber after the first one is reset", async () => {
	const broadcast = new Broadcast({ enabled: true, origin: new Origin.Producer(), name: Path.from("test.hang") });
	broadcast.video("video").config.set(videoConfig);
	await settle();

	const net = broadcast.net.peek();
	if (!net) throw new Error("expected a network producer once connected");
	const front = net.consume();

	// Read the raw groups rather than through a Json.Snapshot consumer: what distinguishes a
	// re-seeded subscriber from one replaying the previous viewer's group is the group it lands in.
	const first = front.subscribe(Broadcast.CATALOG_TRACK);
	const seeded = await first.recvGroup();
	expect(await readSnapshot(seeded)).toBe("avc1.640028");

	// The peer reset the subscribe stream (StreamCode.Cancel, "remote error: 1" on the wire).
	first.close(new Error("remote error: 1"));
	await settle();

	// The next viewer must be seeded in a group of its own. Replaying the group the first viewer
	// drained only works until it ages out of the producer's retained window, after which the tile
	// appears, the subscription is accepted and no catalog ever arrives.
	const second = front.subscribe(Broadcast.CATALOG_TRACK);
	const reseeded = await second.recvGroup();
	expect(reseeded?.sequence).toBeGreaterThan(seeded?.sequence ?? 0);
	expect(await readSnapshot(reseeded)).toBe("avc1.640028");

	second.close();
	front.close();
	broadcast.close();
});

// The codec in a catalog snapshot frame, read straight off the group. CatalogProducer disables
// deltas, so every frame is a whole catalog in a group of its own.
async function readSnapshot(group: Group.Consumer | undefined): Promise<string | undefined> {
	const catalog = (await group?.readJson()) as Catalog.Root | undefined;
	return catalog?.video?.renditions.video?.codec;
}
