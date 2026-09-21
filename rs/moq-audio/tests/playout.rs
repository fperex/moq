//! The jitter buffer as a caller sees it: [`decode::Config::delay`] turns it on,
//! and [`decode::Consumer::read`] then hands back playout blocks instead of the
//! packets it decoded.

use std::time::Duration;

use bytes::Bytes;
use moq_audio::{Format, Frame, decode, encode};
use moq_net::Timestamp;

const RATE: u32 = 48_000;
const CHANNELS: u32 = 2;

/// One 20 ms packet of a tone, the shape an Opus publisher sends.
fn packet(index: usize) -> Bytes {
	let frames = (RATE as usize * 20) / 1000;
	let mut out = Vec::with_capacity(frames * CHANNELS as usize * 4);

	for frame in 0..frames {
		let t = (index * frames + frame) as f32 / RATE as f32;
		let sample = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.5;
		for _ in 0..CHANNELS {
			out.extend_from_slice(&sample.to_le_bytes());
		}
	}

	Bytes::from(out)
}

/// A live PCM broadcast: the consumer to subscribe with, the catalog entry to
/// subscribe to, and the publishing half, which has to stay alive or the track is
/// dropped underneath the test.
struct Fixture {
	consumer: moq_net::broadcast::Consumer,
	catalog: hang::catalog::AudioConfig,
	/// Held open until a test wants the track to end, since finishing it retires
	/// the rendition a subscriber would be looking for.
	producer: Option<encode::Producer>,
	_broadcast: moq_net::broadcast::Producer,
	_catalog: moq_mux::catalog::Producer,
}

impl Fixture {
	/// Publish one 20 ms packet, the `index`th on the track's timeline.
	fn write(&mut self, index: usize) {
		let timestamp = Timestamp::from_micros((index * 20_000) as u64).unwrap();
		self.producer
			.as_mut()
			.expect("the track is live")
			.write(&Frame::new(packet(index), timestamp))
			.unwrap();
	}

	/// End the track, so playout drains and reads stop.
	fn finish(&mut self) {
		self.producer.take().expect("the track is live").finish().unwrap();
	}
}

/// A PCM broadcast, so the test exercises the playout path rather than a codec.
async fn broadcast(packets: usize) -> Fixture {
	let mut broadcast = moq_net::broadcast::Info::new().produce();
	let catalog = moq_mux::catalog::Producer::new(&mut broadcast, moq_mux::catalog::Config::default()).unwrap();
	let mut snapshots = catalog.consume().unwrap();
	let consumer = broadcast.consume();

	let input = encode::Input {
		format: Format::F32,
		sample_rate: RATE,
		channels: CHANNELS,
	};
	let mut options = encode::Options::default();
	options.track = Some("pcm".to_string());
	options.codec = encode::Codec::Pcm;

	let producer = encode::Producer::new(&mut broadcast, catalog.clone(), input, &options).unwrap();

	// The catalog names the rendition while it is live; finishing retires it.
	let snapshot = snapshots.next().await.unwrap().unwrap();
	let config = snapshot.audio.renditions.get("pcm").unwrap().clone();

	let mut fixture = Fixture {
		consumer,
		catalog: config,
		producer: Some(producer),
		_broadcast: broadcast,
		_catalog: catalog,
	};

	for index in 0..packets {
		fixture.write(index);
	}

	fixture
}

/// One 10 ms block, in bytes of interleaved `f32`. What a sink asks for per pull.
const BLOCK: usize = (RATE as usize / 100) * CHANNELS as usize * size_of::<f32>();

/// A publisher running at real time and a speaker pulling at real time, which is
/// the case the jitter buffer exists for: every pull is answered with exactly one
/// block, and the media all arrives on the far side.
#[tokio::test]
async fn playout_hands_back_one_block_at_a_time() {
	const PACKETS: usize = 25;
	/// Enough ahead of the speaker that the loop's own first write fills the level
	/// playout holds (the 80 ms cold-start target plus the packet being played) before
	/// the first block is pulled, and no more: a lead past it is where the playhead
	/// starts rather than audio anyone waits for, so playout would drop it.
	const LEAD: usize = 4;

	let mut fixture = broadcast(LEAD).await;

	let mut config = decode::Config::new();
	config.format = Format::F32;
	config.delay = Some(Duration::from_millis(60));
	config.max_age = Duration::from_millis(500);

	let mut consumer = decode::Consumer::new(&fixture.consumer, &fixture.catalog, "pcm", config)
		.await
		.unwrap();
	assert_eq!(
		consumer.delay(),
		Some(Duration::from_millis(80)),
		"the cold start guess"
	);

	let mut blocks = 0;
	let mut previous: Option<Timestamp> = None;
	let mut pull = async |consumer: &mut decode::Consumer| {
		let frame = consumer.read().await.unwrap()?;
		assert_eq!(frame.data.len(), BLOCK, "block {blocks} came back short");
		if let Some(previous) = previous {
			assert!(frame.timestamp >= previous, "the playhead went backwards");
		}
		previous = Some(frame.timestamp);
		blocks += 1;
		// The device's clock, which is the only thing pacing playout: the read
		// itself never waits.
		tokio::time::sleep(Duration::from_millis(10)).await;
		Some(())
	};

	// A 20 ms packet per two blocks pulled, so arrivals and pulls both run on the
	// wall clock the estimator measures against.
	for index in LEAD..PACKETS {
		fixture.write(index);
		for _ in 0..2 {
			pull(&mut consumer).await.expect("the track is still live");
		}
	}

	fixture.finish();
	while pull(&mut consumer).await.is_some() {}

	// Every packet published reaches the speaker: the buffer delays the media, it
	// does not spend it.
	let played = Duration::from_millis(20 * PACKETS as u64);
	assert_eq!(consumer.playhead(), Some(played), "{blocks} blocks");
	assert!(blocks as u64 >= played.as_millis() as u64 / 10, "{blocks} blocks");
	assert!(
		consumer.delay().unwrap() >= Duration::from_millis(60),
		"the floor was lowered"
	);
}

/// Without the knob nothing changes: packets come back as they are decoded.
#[tokio::test]
async fn without_a_delay_the_packets_come_back_as_they_are() {
	let fixture = broadcast(5).await;

	let mut config = decode::Config::new();
	config.format = Format::F32;

	let mut consumer = decode::Consumer::new(&fixture.consumer, &fixture.catalog, "pcm", config)
		.await
		.unwrap();
	assert_eq!(consumer.delay(), None);
	assert_eq!(consumer.playhead(), None);

	let frame = consumer.read().await.unwrap().unwrap();
	assert_eq!(frame.data.len(), packet(0).len(), "a 20ms packet was split up");
}

/// A floor deeper than the age budget asks playout to hold media the same config
/// throws away, which is a contradiction the caller has to resolve.
#[tokio::test]
async fn a_delay_the_budget_cannot_hold_is_refused() {
	let fixture = broadcast(2).await;

	let mut config = decode::Config::new();
	config.delay = Some(Duration::from_millis(500));
	config.max_age = Duration::from_millis(200);

	let Err(err) = decode::Consumer::new(&fixture.consumer, &fixture.catalog, "pcm", config).await else {
		panic!("a floor above the budget was accepted");
	};
	assert!(matches!(err, moq_audio::Error::Unsupported(_)), "{err}");
	assert!(err.to_string().contains("500ms"), "{err}");
}

/// Playout claims three quarters of the budget, and always leaves it the headroom it
/// has to keep above the target: on a budget this shallow the headroom is what binds,
/// so 500ms of budget holds 375ms and 200ms holds 95ms rather than 150ms.
#[tokio::test]
async fn a_delay_inside_the_budget_is_accepted() {
	let accepted = async |delay: u64, max_age: u64| {
		let fixture = broadcast(2).await;
		let mut config = decode::Config::new();
		config.delay = Some(Duration::from_millis(delay));
		config.max_age = Duration::from_millis(max_age);
		decode::Consumer::new(&fixture.consumer, &fixture.catalog, "pcm", config)
			.await
			.is_ok()
	};

	assert!(accepted(375, 500).await, "the 75% share is the bound at 500ms");
	assert!(!accepted(376, 500).await);

	assert!(accepted(95, 200).await, "the headroom is the bound at 200ms");
	assert!(!accepted(96, 200).await);
}
