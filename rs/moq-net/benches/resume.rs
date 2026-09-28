//! Cached group delivery through a logical track, across cache depth, fanout, and route segments.

use std::hint::black_box;
use std::task::Poll;
use std::time::{Duration, Instant};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use moq_net::{Timestamp, broadcast, cache, group, origin, track};

const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

struct Source {
	_origin: origin::Producer,
	_broadcasts: Vec<broadcast::Producer>,
	_tracks: Vec<track::Producer>,
	_broadcast: broadcast::Consumer,
	_reader: track::Subscriber,
	track: track::Consumer,
}

fn replay() -> track::Subscription {
	track::Subscription::default()
		.with_start(track::Position::group(0))
		.with_max_age(Duration::from_secs(5))
}

async fn source(groups: u64, segments: u64) -> Source {
	let mut config = origin::Config::default();
	config.pool = cache::Pool::new(cache::Config::default().with_expiry(None));
	let (origin, driver) = origin::Producer::new(config);
	tokio::spawn(moq_net::time::run(driver));
	let consumer = origin.consume();
	let mut broadcasts = Vec::new();
	let mut tracks = Vec::new();
	let mut resolved = None;
	let mut resolved_broadcast = None;
	let mut reader: Option<track::Subscriber> = None;

	for segment in 0..segments {
		let broadcast = origin.create_broadcast("bench/live").unwrap();
		let track = broadcast.create_track("data", None).unwrap();
		for sequence in segment * groups..(segment + 1) * groups {
			let mut group = track.create_group(group::Info { sequence }).unwrap();
			group
				.write_frame(Timestamp::from_millis(sequence).unwrap(), b"frame".as_ref())
				.unwrap();
			group.finish().unwrap();
		}
		broadcast.announce(origin::Route::default()).unwrap();
		if reader.is_none() {
			let broadcast = consumer.request_broadcast("bench/live").await.unwrap();
			let track = broadcast.track("data").unwrap();
			reader = Some(track.subscribe(replay()).await.unwrap());
			resolved = Some(track);
			resolved_broadcast = Some(broadcast);
		}
		// Reading each route's groups proves the front applied the takeover before measurement.
		for sequence in segment * groups..(segment + 1) * groups {
			assert_eq!(
				reader.as_mut().unwrap().recv_group().await.unwrap().unwrap().sequence,
				sequence
			);
		}
		broadcasts.push(broadcast);
		tracks.push(track);
	}

	Source {
		_origin: origin,
		_broadcasts: broadcasts,
		_tracks: tracks,
		_broadcast: resolved_broadcast.unwrap(),
		_reader: reader.unwrap(),
		track: resolved.unwrap(),
	}
}

fn delivery(c: &mut Criterion) {
	let mut group = c.benchmark_group("resume_delivery");
	for segments in [1, 2, 3] {
		for groups in [1, 10, 100] {
			for subscribers in [1, 10, 100] {
				let id =
					BenchmarkId::from_parameter(format!("{segments}segments_{groups}groups_{subscribers}subscribers"));
				group.throughput(Throughput::Elements(segments * groups * subscribers));
				group.bench_function(id, |b| {
					let runtime = tokio::runtime::Builder::new_current_thread()
						.enable_all()
						.build()
						.unwrap();
					let source = runtime.block_on(async {
						tokio::time::timeout(SETUP_TIMEOUT, source(groups, segments))
							.await
							.expect("origin route setup timed out")
					});
					let waiter = kio::Waiter::noop();
					b.iter_custom(|iterations| {
						runtime.block_on(async {
							let mut elapsed = Duration::ZERO;
							for _ in 0..iterations {
								let mut cursors = tokio::time::timeout(SETUP_TIMEOUT, async {
									let mut cursors = Vec::with_capacity(subscribers as usize);
									for _ in 0..subscribers {
										cursors.push(source.track.subscribe(replay()).await.unwrap());
									}
									cursors
								})
								.await
								.expect("cached subscriptions timed out");
								let start = Instant::now();
								for sequence in 0..segments * groups {
									for cursor in &mut cursors {
										let Poll::Ready(Ok(Some(received))) = cursor.poll_recv_group(&waiter) else {
											panic!("cached group must be ready");
										};
										assert_eq!(received.sequence, sequence);
										black_box(received);
									}
								}
								for cursor in &mut cursors {
									assert!(cursor.poll_recv_group(&waiter).is_pending());
								}
								elapsed += start.elapsed();
							}
							elapsed
						})
					});
				});
			}
		}
	}

	group.finish();
}

criterion_group!(benches, delivery);
criterion_main!(benches);
