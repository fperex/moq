//! Recorded arrivals, replayed through the estimator the way the consumer drives it.
//!
//! The corpus next door is synthetic and holds the algorithm to the page. These are
//! the traces the browser replays in `js/watch/src/audio/replay.test.ts`,
//! trimmed from the recordings attached to moq-dev/moq#3477, and they answer a
//! different question: on a real path, do the two languages size the buffer the
//! same?
//!
//! The fixtures stay where the browser keeps them and are read at run time, so there
//! is one copy of each recording rather than two that can drift apart. A test run
//! outside a checkout, from a packaged crate, therefore fails here rather than
//! quietly passing.

use std::time::Duration;

use serde_json::Value;

use super::delay::{Jitter, Observation};

/// Where the browser keeps the recordings, relative to this crate.
const FIXTURES: &str = "../../js/watch/src/audio/fixtures";

/// The target a recording settles on, replayed arrival by arrival.
fn replay(name: &str) -> Duration {
	let path = format!("{}/{FIXTURES}/{name}.json", env!("CARGO_MANIFEST_DIR"));
	let raw = std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("cannot read {path}: {err}"));
	let fixture: Value = serde_json::from_str(&raw).expect("the fixture is valid JSON");

	let arrivals = fixture["arrivals"].as_array().expect("the fixture holds arrivals");
	assert!(!arrivals.is_empty(), "{name} holds no arrivals");

	let mut jitter = Jitter::new();
	for arrival in arrivals {
		// A declared endpoint carries no media, so it is not an arrival to measure a path against:
		// the publisher said where its timeline stopped rather than running late.
		if arrival["endpoint"].as_bool().unwrap_or(false) {
			continue;
		}
		let timestamp = arrival["timestamp_us"].as_f64().expect("a timestamp");
		let now = arrival["arrival_ms"].as_f64().expect("an arrival");
		// A recording that watched its own event loop says which frames came out of a
		// block; one that did not carries nothing and is read the same way as before.
		let observation = Observation {
			stalled: arrival["stalled"].as_bool().unwrap_or(false),
			..Default::default()
		};
		jitter.observe(
			Duration::from_nanos((timestamp * 1000.0).round() as u64),
			now,
			observation,
		);
	}

	jitter.target()
}

/// A well paced publisher over a LAN relay: the easy case, where the buffer only
/// has to cover local scheduling noise.
#[test]
fn a_lan_path_settles_where_the_browser_settles() {
	assert_eq!(replay("lan-bbb"), Duration::from_millis(80));
}

/// The public relay serving `bbb.hang`, whose importer packs seven AAC frames into
/// one PES and forwards the lot in a single pass. No round-trip formula can see
/// that; the measured target covers it.
#[test]
fn a_seven_frame_flush_settles_where_the_browser_settles() {
	assert_eq!(replay("relay-bbb-7frame"), Duration::from_millis(240));
}

/// A browser publisher's microphone over a local relay: 20ms Opus, one frame per
/// group. The spread is so narrow that the estimator sits on its lowest value, which
/// is the case the ring's own level has to carry.
#[test]
fn a_local_microphone_settles_where_the_browser_settles() {
	assert_eq!(replay("mic-local"), Duration::from_millis(20));
}

/// The same publisher through the public relay, 45ms round trip. A wide-area path
/// adds delay, not spread, so the target is the same 20ms and the listener's wait is
/// the level playout holds on top of it.
#[test]
fn a_remote_microphone_settles_where_the_browser_settles() {
	assert_eq!(replay("mic-remote"), Duration::from_millis(20));
}

/// A receiver whose own content process froze in bursts, which the recording marks
/// because its debug sampler was blocked alongside the read loop. The path was clean
/// throughout, so a target the size of the freeze is one nothing measured asked for:
/// reading the marks takes it from 1600ms to the 300ms the blocks too short for that
/// sampler to resolve still leave behind.
#[test]
fn a_blocked_receiver_settles_where_the_browser_settles() {
	assert_eq!(replay("mic-firefox"), Duration::from_millis(300));
}
