//! Recorded arrivals, replayed through the estimator the way the consumer drives it.
//!
//! The corpus next door is synthetic and holds the algorithm to the page. These are
//! two of the traces the browser replays in `js/watch/src/audio/replay.test.ts`,
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

use super::delay::Jitter;

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
		let timestamp = arrival["timestamp_us"].as_f64().expect("a timestamp");
		let now = arrival["arrival_ms"].as_f64().expect("an arrival");
		jitter.observe(Duration::from_nanos((timestamp * 1000.0).round() as u64), now, false);
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
