//! The cross-language conformance corpus for [`Jitter`](super::delay::Jitter).
//!
//! `tests/playout-01.json` holds arrival traces, with the player's run-dry reports
//! among them, and the target series each one must produce.
//! `js/hang/src/container/jitter.vectors.ts` generates it from the browser
//! estimator, and this replays it through the native one: both languages are held to
//! `doc/concept/playout.md` rather than to each other, and a divergence is a bug in
//! whichever one departed from the page.
//!
//! It lives here rather than in `tests/` because the estimator is crate-private, and
//! it stays the only thing that reads the file so `cargo package` keeps it in reach
//! (the same reason `rs/moq-json/tests/vectors.json` lives where it does).

use std::time::Duration;

use serde_json::Value;

use super::delay::{BUCKET, FORGET, HOLD, Jitter, LOWER_DIVISOR, Observation, STALL_WINDOW};

/// The corpus, checked in beside the tests that consume it.
const CORPUS: &str = include_str!("../../tests/playout-01.json");

/// The algorithm this crate implements. A corpus naming a different one is for a
/// different estimator and is not silently replayed against this one.
const ALGORITHM: &str = "moq-playout-01";

fn corpus() -> Value {
	serde_json::from_str(CORPUS).expect("the corpus is valid JSON")
}

fn number(value: &Value, key: &str) -> f64 {
	value[key].as_f64().unwrap_or_else(|| panic!("`{key}` is a number"))
}

/// Every case, replayed entry by entry, compared as whole milliseconds.
///
/// Exact equality: every target in the corpus is a whole multiple of one bucket, so
/// an `f64` difference between V8 and rustc cannot reach this comparison.
#[test]
fn the_corpus_passes() {
	let corpus = corpus();
	assert_eq!(corpus["algorithm"].as_str(), Some(ALGORITHM));

	let cases = corpus["cases"].as_array().expect("the corpus holds cases");
	assert!(!cases.is_empty(), "the corpus holds no cases");

	for case in cases {
		let name = case["name"].as_str().expect("a case has a name");
		let arrivals = case["arrivals"].as_array().expect("a case has arrivals");
		let targets = case["target_ms"].as_array().expect("a case has targets");
		assert_eq!(
			arrivals.len(),
			targets.len(),
			"{name}: one target per entry, got {} and {}",
			arrivals.len(),
			targets.len()
		);

		// A case naming a flush span is one that starts from the publisher's declaration;
		// the rest start from NetEq's guess.
		let mut jitter = match case["start_ms"].as_f64() {
			Some(start) => Jitter::seeded(Duration::from_secs_f64(start / 1000.0)),
			None => Jitter::new(),
		};

		for (index, (arrival, expected)) in arrivals.iter().zip(targets).enumerate() {
			// An entry is a frame arriving, or the player reporting that it ran dry.
			if let Some(gap) = arrival["starved_ms"].as_f64() {
				let gap = Duration::from_nanos((gap * 1_000_000.0).round() as u64);
				jitter.starved(gap, number(arrival, "arrival_ms"));
			} else {
				if arrival["reanchor_before"].as_bool().unwrap_or(false) {
					jitter.reanchor();
				}

				let timestamp = Duration::from_nanos((number(arrival, "timestamp_us") * 1000.0).round() as u64);
				let observation = Observation {
					reordered: arrival["reordered"].as_bool().unwrap_or(false),
					stalled: arrival["stalled"].as_bool().unwrap_or(false),
				};
				jitter.observe(timestamp, number(arrival, "arrival_ms"), observation);
			}

			let expected = expected.as_f64().expect("a target is a number");
			let actual = jitter.target().as_secs_f64() * 1000.0;
			assert_eq!(
				actual, expected,
				"{name}[{index}]: target {actual}ms, corpus says {expected}ms"
			);
		}
	}
}

/// The constants the two implementations share, so a change to either is caught
/// here rather than as a divergence twelve cases later.
#[test]
fn the_constants_match() {
	let corpus = corpus();
	let constants = &corpus["constants"];

	assert_eq!(number(constants, "bucket_ms"), BUCKET);
	assert_eq!(number(constants, "buckets"), 100.0);
	assert_eq!(number(constants, "quantile"), 0.95);
	assert_eq!(number(constants, "forget"), FORGET);
	assert_eq!(number(constants, "start_forget_weight"), 2.0);
	assert_eq!(number(constants, "resample_ms"), 500.0);
	assert_eq!(number(constants, "window_ms"), 2000.0);
	assert_eq!(number(constants, "start_ms"), 80.0);
	assert_eq!(number(constants, "max_catchup"), 60.0);
	assert_eq!(number(constants, "lower_interval_ms"), 1000.0);
	assert_eq!(number(constants, "lower_divisor"), LOWER_DIVISOR);
	assert_eq!(number(constants, "hold_ms"), HOLD);
	assert_eq!(number(constants, "stall_window_ms"), STALL_WINDOW);
}

/// Every case the page names, so one silently dropped from the generator shows up
/// here instead of as coverage nobody notices is gone.
#[test]
fn every_case_is_present() {
	let corpus = corpus();
	let names: Vec<&str> = corpus["cases"]
		.as_array()
		.expect("the corpus holds cases")
		.iter()
		.map(|case| case["name"].as_str().expect("a case has a name"))
		.collect();

	for expected in [
		"steady",
		"steady-far",
		"burst-2",
		"burst-7",
		"slow-buildup",
		"step-change",
		"reordered",
		"tune-in-stale",
		"tune-in-stall",
		"pause-10s",
		"pause-10min",
		"discontinuity",
		"outlier",
		"sparse",
		"receiver-stall",
		"receiver-stall-unflagged",
		"seeded",
		"run-dry",
		"run-dry-repeated",
		"run-dry-below-histogram",
		"run-dry-before-measurement",
		"run-dry-unstalled",
		"run-dry-outside-window",
	] {
		assert!(names.contains(&expected), "the corpus lost `{expected}`");
	}
}
