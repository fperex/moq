//! Cached group delivery through a logical track, across cache depth, fanout, and route segments.

use std::hint::black_box;
use std::task::Poll;
use std::time::{Duration, Instant};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use moq_net::{Hop, Hops, Timestamp, broadcast, cache, group, origin, track};

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

async fn warm_source(groups: u64) -> (Source, origin::Dynamic, broadcast::Dynamic) {
	let mut config = origin::Config::new(Hop::new(1).unwrap());
	config.pool = cache::Pool::new(cache::Config::default().with_expiry(None));
	let (origin, driver) = origin::Producer::new(config);
	tokio::spawn(moq_net::time::run(driver));
	let consumer = origin.consume();
	let mut hops = Hops::new();
	hops.push(Hop::new(10).unwrap()).unwrap();
	let server = origin
		.dynamic("bench/warm", origin::Route::default().with_hops(hops))
		.unwrap();
	let pending = consumer.request_broadcast("bench/warm");
	let upstream = broadcast::Info::new().produce();
	let mut dynamic = upstream.dynamic();
	server.requested_broadcast().await.unwrap().accept(&upstream);
	let broadcast = pending.await.unwrap();
	let track = broadcast.track("data").unwrap();
	let subscribing = tokio::spawn({
		let track = track.clone();
		async move { track.subscribe(replay()).await.unwrap() }
	});
	let old = dynamic.requested_track().await.unwrap().accept(None);
	for sequence in 0..groups {
		let mut group = old.create_group(sequence.into()).unwrap();
		group
			.write_frame(Timestamp::from_millis(sequence).unwrap(), b"frame".as_ref())
			.unwrap();
		group.finish().unwrap();
	}
	let mut reader = subscribing.await.unwrap();
	for sequence in 0..groups {
		assert_eq!(reader.recv_group().await.unwrap().unwrap().sequence, sequence);
	}
	drop(reader);
	drop(track);
	old.unused().await.unwrap();
	drop(old);

	let track = broadcast.track("data").unwrap();
	let subscribing = tokio::spawn({
		let track = track.clone();
		async move { track.subscribe(replay()).await.unwrap() }
	});
	let mut live = dynamic.requested_track().await.unwrap().accept(None);
	live.start_at(groups - 1).unwrap();
	for sequence in groups..=2 * groups {
		let mut group = live.create_group(sequence.into()).unwrap();
		group
			.write_frame(Timestamp::from_millis(sequence).unwrap(), b"frame".as_ref())
			.unwrap();
		group.finish().unwrap();
	}
	let mut reader = subscribing.await.unwrap();
	for sequence in 0..=2 * groups {
		assert_eq!(reader.recv_group().await.unwrap().unwrap().sequence, sequence);
	}
	(
		Source {
			_origin: origin,
			_broadcasts: vec![upstream],
			_tracks: vec![live],
			_broadcast: broadcast,
			_reader: reader,
			track,
		},
		server,
		dynamic,
	)
}

fn warm_delivery(c: &mut Criterion) {
	let mut group = c.benchmark_group("resume_warm");
	for groups in [1, 10, 100] {
		for subscribers in [1, 10, 100] {
			let id = BenchmarkId::from_parameter(format!("{groups}groups_{subscribers}subscribers"));
			group.throughput(Throughput::Elements(groups * subscribers));
			group.bench_function(id, |b| {
				let runtime = tokio::runtime::Builder::new_current_thread()
					.enable_all()
					.build()
					.unwrap();
				let (source, _server, _dynamic) = runtime.block_on(async {
					tokio::time::timeout(SETUP_TIMEOUT, warm_source(groups))
						.await
						.expect("warm route setup timed out")
				});
				let waiter = kio::Waiter::noop();
				b.iter_custom(|iterations| {
					runtime.block_on(async {
						let mut elapsed = Duration::ZERO;
						for _ in 0..iterations {
							let mut cursors = tokio::time::timeout(SETUP_TIMEOUT, async {
								let mut cursors = Vec::with_capacity(subscribers as usize);
								for _ in 0..subscribers {
									let mut cursor = source.track.subscribe(replay()).await.unwrap();
									// Drain the real warm cache and its boundary before measuring live delivery.
									for sequence in 0..=groups {
										assert_eq!(cursor.recv_group().await.unwrap().unwrap().sequence, sequence);
									}
									cursors.push(cursor);
								}
								cursors
							})
							.await
							.expect("warm subscriptions timed out");
							let start = Instant::now();
							for sequence in groups + 1..=2 * groups {
								for cursor in &mut cursors {
									let Poll::Ready(Ok(Some(received))) = cursor.poll_recv_group(&waiter) else {
										panic!("live cached group must be ready");
									};
									assert_eq!(received.sequence, sequence);
									black_box(received);
									assert!(cursor.poll_recv_datagram(&waiter).is_pending());
									assert!(cursor.poll_finished(&waiter).is_pending());
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
	group.finish();
}

criterion_group!(benches, delivery, warm_delivery);
criterion_main!(benches);
