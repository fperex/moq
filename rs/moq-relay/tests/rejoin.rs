//! A viewer that leaves and comes back through a real relay is never handed media from
//! before it left.
//!
//! When the last subscriber leaves, the relay cancels its upstream subscription and keeps
//! the track's newest groups warm. A returning subscriber may be served that cache only if
//! the publisher's feed still continues from it. The relay meets two publisher shapes:
//!
//! - one that keeps producing while nobody watches, the shape the warm-cache tests in
//!   `moq-tokio` cover without a relay;
//! - one that stops on demand loss and marks the break, the way `@moq/publish` does: its
//!   encoder only runs while a subscriber is attached, and when the last one leaves it
//!   finishes the current group at its end and appends a marker group of one empty frame
//!   there (`Container.Legacy.Producer.cut`). It resumes with a new keyframe group once a
//!   subscriber returns, some time after the subscription arrives.
//!
//! The assertion is the same for both: the returning subscriber's first group, and every
//! group after it, comes from after the gap.
#![cfg(feature = "noq")]

use std::time::Duration;

use moq_relay::{Config, Relay};
use moq_tokio::moq_net;

/// Ceiling for every wait, so a broken rejoin fails with a message instead of hanging.
const TIMEOUT: Duration = Duration::from_secs(10);

/// The track every case publishes.
const TRACK: &str = "video";

/// The age budget both viewers subscribe with, as a live player's is: far below the gap.
const BUDGET: Duration = Duration::from_millis(100);

/// Where the first group after the gap starts, well past the budget from anything before it.
const RESUMED_MS: u64 = 10_000;

/// What the publisher does while nobody is watching.
#[derive(Clone, Copy, Debug)]
enum Idle {
	/// Keeps producing, like an encoder that never stops.
	Produces,
	/// Stops producing and marks the break, like `@moq/publish` (see the module docs).
	Pauses,
}

fn ms(ms: u64) -> moq_net::Timestamp {
	moq_net::Timestamp::from_millis(ms).expect("timestamp")
}

/// Bind a public relay on an ephemeral loopback port and serve it on this runtime.
async fn relay() -> (url::Url, tokio::task::JoinHandle<()>) {
	// Process-global; every case in this binary races to be first.
	let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

	let mut config = Config::default();
	config.listen.bind = Some("127.0.0.1:0".parse().unwrap());
	config.listen.tls.generate = vec!["localhost".into()];
	config.auth.public = vec![moq_auth::Pattern::all()];

	let relay = Relay::load(config).await.expect("load relay");
	let addr = relay.quic_addr().expect("relay bound no QUIC address");
	let url = format!("https://127.0.0.1:{}/rejoin", addr.port()).parse().unwrap();
	let handle = tokio::spawn(async move {
		let _ = relay.run().await;
	});
	(url, handle)
}

/// A one-shot QUIC client pinned to `version`, trusting the relay's generated certificate.
fn client(version: moq_net::Version) -> moq_tokio::Client {
	let mut config = moq_tokio::connect::Config::default();
	config.bind = Some("127.0.0.1:0".parse().unwrap());
	config.tls.insecure = Some(true);
	config.websocket.enabled = Some(false);
	config.version = vec![version];
	config.init(Default::default()).expect("client init")
}

/// Write a finished group of two frames, at `at` and 50ms later.
fn write_group(track: &moq_net::track::Producer, sequence: u64, at: u64) {
	let mut group = track
		.create_group(moq_net::group::Info { sequence })
		.expect("create group");
	group.write_frame(ms(at), b"frame".as_ref()).expect("write frame");
	group.write_frame(ms(at + 50), b"frame".as_ref()).expect("write frame");
	group.finish().expect("finish group");
}

/// Open a subscriber session and subscribe to [`TRACK`] once `live` is announced.
async fn subscribe(url: &url::Url, version: moq_net::Version) -> (moq_tokio::Connection, moq_net::track::Subscriber) {
	let origin = moq_tokio::origin::spawn();
	let consumer = origin.consume();
	let session = tokio::time::timeout(
		TIMEOUT,
		client(version)
			.with_subscriber(origin)
			.with_reconnect(false)
			.connect(url.clone())
			.established(),
	)
	.await
	.expect("subscriber connect timed out")
	.expect("subscriber connect failed");

	let broadcast = tokio::time::timeout(TIMEOUT, consumer.routed_broadcast("live"))
		.await
		.expect("announcement timed out")
		.expect("origin closed before announcing");
	let subscriber = tokio::time::timeout(
		TIMEOUT,
		broadcast
			.track(TRACK)
			.expect("track")
			.subscribe(moq_net::track::Subscription::default().with_max_age(BUDGET)),
	)
	.await
	.expect("subscribe timed out")
	.expect("subscribe rejected");
	(session, subscriber)
}

async fn recv(subscriber: &mut moq_net::track::Subscriber, what: &str) -> moq_net::group::Consumer {
	tokio::time::timeout(TIMEOUT, subscriber.recv_group())
		.await
		.unwrap_or_else(|_| panic!("{what}: no group within {TIMEOUT:?}"))
		.unwrap_or_else(|err| panic!("{what}: track aborted: {err}"))
		.unwrap_or_else(|| panic!("{what}: track finished"))
}

async fn rejoin(version: moq_net::Version, idle: Idle, open: bool) {
	let case = format!("{version} {idle:?} open={open}");
	let (url, relay) = relay().await;

	let publisher = moq_tokio::origin::spawn();
	let broadcast = publisher.create_broadcast("live").expect("create broadcast");
	broadcast.announce(Default::default()).expect("announce");
	let track = broadcast.create_track(TRACK, None).expect("create track");
	for sequence in 0..3u64 {
		write_group(&track, sequence, sequence * 100);
	}
	// The group live when the viewer leaves: still open, or finished just before.
	let mut edge = track
		.create_group(moq_net::group::Info { sequence: 3 })
		.expect("create edge group");
	edge.write_frame(ms(300), b"edge".as_ref()).expect("write edge frame");
	if !open {
		edge.write_frame(ms(350), b"edge".as_ref()).expect("write edge frame");
		edge.finish().expect("finish edge group");
	}

	let publish_session = tokio::time::timeout(
		TIMEOUT,
		client(version)
			.with_publisher(&publisher)
			.with_reconnect(false)
			.connect(url.clone())
			.established(),
	)
	.await
	.expect("publisher connect timed out")
	.expect("publisher connect failed");

	// The viewer watches up to the edge, then leaves with its whole session, as a detached
	// player does.
	let (session, mut subscriber) = subscribe(&url, version).await;
	loop {
		let mut group = recv(&mut subscriber, &format!("{case}: first viewer")).await;
		if group.sequence != 3 {
			continue;
		}
		let frame = tokio::time::timeout(TIMEOUT, group.read_frame())
			.await
			.expect("edge frame timed out")
			.expect("edge frame failed")
			.expect("edge group ended before its frame");
		assert_eq!(&frame.payload[..], b"edge");
		break;
	}
	drop(subscriber);
	drop(session);

	// The relay cancels upstream once nobody reads.
	tokio::time::timeout(TIMEOUT, track.unused())
		.await
		.unwrap_or_else(|_| panic!("{case}: the relay never cancelled upstream"))
		.expect("track open");

	// The first group after the gap.
	let resumed = 4;
	match idle {
		Idle::Produces => {
			for sequence in resumed..=20u64 {
				write_group(&track, sequence, RESUMED_MS + (sequence - resumed) * 100);
			}
		}
		Idle::Pauses => {
			// The break, as `cut` marks it: a group still open ends with an empty frame one
			// interval after its last one, then a marker group holds one empty frame at the
			// last frame written.
			let last = if open { 300 } else { 350 };
			if open {
				edge.write_frame(ms(last + 50), b"".as_ref()).expect("write end frame");
				edge.finish().expect("finish edge group");
			}
			let mut marker = track
				.create_group(moq_net::group::Info { sequence: resumed })
				.expect("create marker group");
			marker.write_frame(ms(last), b"".as_ref()).expect("write marker");
			marker.finish().expect("finish marker group");
		}
	}

	let (session, mut subscriber) = subscribe(&url, version).await;
	let first = recv(&mut subscriber, &format!("{case}: returning viewer"))
		.await
		.sequence;
	assert!(
		first >= resumed,
		"{case}: the returning viewer was first served group {first}, from before it left"
	);

	// A paused publisher resumes only once the encoder has produced its first frame, after
	// the subscription is already being served.
	let last = match idle {
		Idle::Produces => 20,
		Idle::Pauses => {
			write_group(&track, resumed + 1, RESUMED_MS);
			resumed + 1
		}
	};
	let mut sequence = first;
	while sequence < last {
		sequence = recv(&mut subscriber, &format!("{case}: returning viewer"))
			.await
			.sequence;
		assert!(
			sequence >= resumed,
			"{case}: the returning viewer was served group {sequence}, from before it left"
		);
	}

	drop(subscriber);
	drop(session);
	drop(edge);
	drop(publish_session);
	relay.abort();
}

/// Every version whose relay resolves a rejoin against the publisher (lite-06 onward and IETF)
/// that `wanted` keeps.
fn versions(wanted: fn(&moq_net::Version) -> bool) -> impl Iterator<Item = moq_net::Version> {
	let pre06 = [
		"moq-lite-01",
		"moq-lite-02",
		"moq-lite-03",
		"moq-lite-04",
		"moq-lite-05",
	];
	moq_net::Version::names()
		.filter(move |name| !pre06.contains(name))
		.map(|name| name.parse().expect("version"))
		.filter(wanted)
}

/// Run each version with the edge group open and finished, and report every case that fails.
async fn every_case(idle: Idle, wanted: fn(&moq_net::Version) -> bool) {
	let mut failed = Vec::new();
	let mut cases = 0;
	for version in versions(wanted) {
		for open in [false, true] {
			cases += 1;
			if let Err(err) = tokio::spawn(rejoin(version, idle, open)).await {
				let panic = err.into_panic();
				let message = panic
					.downcast_ref::<String>()
					.cloned()
					.or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
					.unwrap_or_default();
				failed.push(message);
			}
		}
	}
	assert!(cases > 0, "no version to run");
	assert!(
		failed.is_empty(),
		"{} of {cases} cases failed:\n{}",
		failed.len(),
		failed.join("\n")
	);
}

#[tokio::test]
async fn rejoin_skips_a_stale_cache_of_a_publisher_that_kept_producing() {
	every_case(Idle::Produces, |_| true).await;
}

/// IETF learns the publisher's newest group from SUBSCRIBE_OK's Largest, and the break's marker
/// group is past the cache.
#[tokio::test]
async fn rejoin_over_ietf_skips_a_stale_cache_of_a_publisher_that_paused() {
	every_case(Idle::Pauses, |version| matches!(version, moq_net::Version::Ietf(_))).await;
}

/// Lite resolves the returning subscription's start from the publisher's own budget, and a paused
/// publisher's pre-gap group is not stale by it: the marker after it is stamped where the media
/// stopped, so nothing newer exists until the resumed keyframe.
#[tokio::test]
async fn rejoin_over_lite_skips_a_stale_cache_of_a_publisher_that_paused() {
	every_case(Idle::Pauses, |version| matches!(version, moq_net::Version::Lite(_))).await;
}
