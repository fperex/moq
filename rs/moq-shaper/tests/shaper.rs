//! End to end drills through a real loopback UDP path.
//!
//! Every drill asserts what the shaper did as well as what arrived, because a profile
//! that silently treated nothing turns an impaired run into an unimpaired pass.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use moq_shaper::{Burst, Config, Counters, Direction, Profile, Shaper, Step};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

/// Ceiling for anything a drill waits on, so a stuck queue fails with a message.
const TIMEOUT: Duration = Duration::from_secs(3);

/// An upstream that records the id and arrival time of every datagram that reaches it.
struct Upstream {
	addr: SocketAddr,
	received: Arc<Mutex<Vec<(u32, Instant)>>>,
}

impl Upstream {
	async fn start() -> Self {
		let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
		let addr = socket.local_addr().unwrap();
		let received = Arc::new(Mutex::new(Vec::new()));

		let sink = received.clone();
		tokio::spawn(async move {
			let mut buf = [0u8; 64];
			while let Ok((size, _)) = socket.recv_from(&mut buf).await {
				let id = u32::from_be_bytes(buf[..size.min(4)].try_into().unwrap());
				sink.lock().unwrap().push((id, Instant::now()));
			}
		});

		Self { addr, received }
	}
}

/// Bind a shaper on an ephemeral port and start forwarding.
async fn start(profile: Profile, upstream: SocketAddr, tcp_passthrough: bool) -> Arc<Shaper> {
	let shaper = Arc::new(
		Shaper::bind(Config {
			listen: "127.0.0.1:0".parse().unwrap(),
			upstream,
			profile,
			tcp_passthrough,
		})
		.await
		.unwrap(),
	);

	let running = shaper.clone();
	tokio::spawn(async move { running.run().await });

	shaper
}

/// Send `count` numbered datagrams, returning when each has left the client.
///
/// The pause is not a settling delay: a thousand datagrams pushed into loopback at once
/// overrun the receive buffer, and a datagram the kernel drops is one the shaper never
/// decided anything about.
async fn blast(to: SocketAddr, count: u32, spacing: Duration) -> Vec<Instant> {
	let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
	let mut sent = Vec::with_capacity(count as usize);

	for id in 0..count {
		sent.push(Instant::now());
		client.send_to(&id.to_be_bytes(), to).await.unwrap();

		match spacing.is_zero() {
			true if id % 20 == 19 => tokio::time::sleep(Duration::from_millis(1)).await,
			true => {}
			false => tokio::time::sleep(spacing).await,
		}
	}

	sent
}

/// Wait until every datagram has been released or dropped and the upstream has seen it.
async fn settle(shaper: &Shaper, upstream: &Upstream, sent: u64) -> Vec<(u32, Instant)> {
	let deadline = Instant::now() + TIMEOUT;

	loop {
		let counters = shaper.report().up;
		let seen = upstream.received.lock().unwrap().len() as u64;

		if counters.delivered + counters.dropped >= sent && seen >= counters.delivered {
			return upstream.received.lock().unwrap().clone();
		}

		assert!(
			Instant::now() < deadline,
			"only {} of {sent} datagrams were accounted for ({seen} arrived): {counters:?}",
			counters.delivered + counters.dropped,
		);

		tokio::time::sleep(Duration::from_millis(5)).await;
	}
}

/// A profile with one direction's treatment spelled out and the other left alone.
fn upward(name: &str, seed: u64, up: Direction) -> Profile {
	Profile {
		name: name.to_string(),
		seed,
		up,
		down: Direction::default(),
	}
}

/// One scripted run: a thousand numbered datagrams through the `lossy` profile.
async fn scripted() -> (Vec<u32>, Counters) {
	let upstream = Upstream::start().await;
	let shaper = start(Profile::parse("lossy").unwrap(), upstream.addr, false).await;

	blast(shaper.local_addr(), 1000, Duration::ZERO).await;
	let arrived = settle(&shaper, &upstream, 1000).await;

	(arrived.into_iter().map(|(id, _)| id).collect(), shaper.report().up)
}

/// The ids that arrived after a higher-numbered one, which is what a reorder looks like.
fn late(ids: &[u32]) -> Vec<u32> {
	let mut newest = 0;
	let mut late = Vec::new();

	for &id in ids {
		match id < newest {
			true => late.push(id),
			false => newest = id,
		}
	}

	late.sort_unstable();
	late
}

#[tokio::test]
async fn the_same_seed_treats_the_same_datagrams() {
	let (first_ids, first) = scripted().await;
	let (second_ids, second) = scripted().await;

	// `queue_max` is how many datagrams happened to be waiting at once, which is the
	// host's clock rather than a decision, so it is deliberately left out.
	let decisions = |c: Counters| [c.delivered, c.dropped, c.delayed, c.reordered, c.rate_limited];
	assert_eq!(
		decisions(first),
		decisions(second),
		"the same seed reached different counters"
	);

	// The decisions replay, not the clock: the same datagrams are dropped and the same
	// ones are held back, but how far a held datagram slips past its neighbours is the
	// host's scheduling, so the raw arrival order is not compared.
	let mut first_delivered = first_ids.clone();
	let mut second_delivered = second_ids.clone();
	first_delivered.sort_unstable();
	second_delivered.sort_unstable();

	assert_eq!(
		first_delivered, second_delivered,
		"a different set of datagrams was dropped"
	);
	assert_eq!(
		late(&first_ids),
		late(&second_ids),
		"a different set of datagrams was reordered"
	);
	assert!(
		!late(&first_ids).is_empty(),
		"nothing was reordered, so there is nothing to replay"
	);
}

#[tokio::test]
async fn the_lossy_profile_drops_about_two_percent() {
	let (ids, counters) = scripted().await;

	assert_eq!(counters.delivered + counters.dropped, 1000);
	assert!(
		(5..=50).contains(&counters.dropped),
		"expected roughly 2% of 1000 dropped, got {}",
		counters.dropped
	);
	assert!(counters.reordered > 0, "the reorder draw never fired");
	assert!(counters.delayed > 0, "nothing was held back");

	// A reordered datagram is one that arrives after a higher-numbered one.
	let out_of_order = ids.windows(2).filter(|pair| pair[0] > pair[1]).count();
	assert!(out_of_order > 0, "the delivery order was untouched");
}

#[tokio::test]
async fn the_control_profile_delivers_everything_in_order() {
	let upstream = Upstream::start().await;
	let shaper = start(Profile::parse("near-zero").unwrap(), upstream.addr, false).await;

	blast(shaper.local_addr(), 200, Duration::ZERO).await;
	let arrived = settle(&shaper, &upstream, 200).await;

	let ids: Vec<u32> = arrived.into_iter().map(|(id, _)| id).collect();
	assert_eq!(ids, (0..200).collect::<Vec<_>>());

	let counters = shaper.report().up;
	assert_eq!(counters.dropped, 0);
	assert_eq!(counters.delivered, 200);
}

#[tokio::test]
async fn a_jittery_path_delivers_everything_in_order() {
	// Jitter is queueing delay on a FIFO path: it moves when a datagram leaves, never
	// which one leaves first. A shaper whose jitter overtook would hand QUIC a gap it can
	// only read as loss, and every row run over it would measure the congestion response.
	let upstream = Upstream::start().await;
	let shape = Direction {
		delay: Duration::from_millis(5),
		jitter: Duration::from_millis(50),
		..Default::default()
	};
	let shaper = start(upward("jittery", 23, shape), upstream.addr, false).await;

	blast(shaper.local_addr(), 300, Duration::ZERO).await;
	let arrived = settle(&shaper, &upstream, 300).await;

	let ids: Vec<u32> = arrived.into_iter().map(|(id, _)| id).collect();
	assert_eq!(ids, (0..300).collect::<Vec<_>>(), "a jittery path reordered");

	let counters = shaper.report().up;
	assert_eq!(counters.reordered, 0, "nothing asked for a reorder");
	assert!(counters.delayed > 0, "nothing was held back");
}

#[tokio::test]
async fn an_untreated_profile_reports_nothing_delayed() {
	// This is the rule a harness leans on: a row whose active profile delayed nothing
	// never applied its impairment, so the control has to be the only profile that
	// legitimately reports zero.
	let upstream = Upstream::start().await;
	let control = start(Profile::parse("near-zero").unwrap(), upstream.addr, false).await;

	blast(control.local_addr(), 100, Duration::ZERO).await;
	settle(&control, &upstream, 100).await;

	let counters = control.report().up;
	assert_eq!(counters.delayed, 0);
	assert!(counters.delivered > 0);

	let delayed = Upstream::start().await;
	let shape = Direction {
		delay: Duration::from_millis(10),
		..Default::default()
	};
	let shaper = start(upward("fixed", 9, shape), delayed.addr, false).await;

	blast(shaper.local_addr(), 100, Duration::ZERO).await;
	settle(&shaper, &delayed, 100).await;

	let counters = shaper.report().up;
	assert_eq!(
		counters.delayed, counters.delivered,
		"a fixed delay must treat every datagram"
	);
}

#[tokio::test]
async fn a_burst_profile_releases_datagrams_together() {
	let upstream = Upstream::start().await;
	let shaper = start(Profile::parse("bursty").unwrap(), upstream.addr, false).await;

	// Three full batches of seven, each filled well inside the 160ms window.
	blast(shaper.local_addr(), 21, Duration::from_millis(10)).await;
	let arrived = settle(&shaper, &upstream, 21).await;
	assert_eq!(arrived.len(), 21);

	let batches: Vec<&[(u32, Instant)]> = arrived.chunks(7).collect();
	for batch in &batches {
		let spread = batch.last().unwrap().1.duration_since(batch[0].1);
		assert!(
			spread < Duration::from_millis(15),
			"a batch arrived spread over {spread:?}"
		);
	}

	for pair in batches.windows(2) {
		let gap = pair[1][0].1.duration_since(pair[0][0].1);
		assert!(gap > Duration::from_millis(40), "two batches arrived {gap:?} apart");
	}

	let counters = shaper.report().up;
	assert_eq!(counters.dropped, 0);
	assert!(
		counters.delayed >= 18,
		"every datagram but the last of each batch waits"
	);
}

#[tokio::test]
async fn a_step_profile_gets_worse_part_way_through() {
	let upstream = Upstream::start().await;
	let shape = Direction {
		delay: Duration::from_millis(5),
		steps: vec![Step {
			at: Duration::from_millis(150),
			delay: Some(Duration::from_millis(60)),
			..Default::default()
		}],
		..Default::default()
	};
	let shaper = start(upward("step-fast", 11, shape), upstream.addr, false).await;

	let sent = blast(shaper.local_addr(), 40, Duration::from_millis(10)).await;
	let arrived = settle(&shaper, &upstream, 40).await;
	assert_eq!(arrived.len(), 40);

	let latency = |range: std::ops::Range<usize>| {
		let mut samples: Vec<Duration> = arrived[range.clone()]
			.iter()
			.map(|(id, at)| at.duration_since(sent[*id as usize]))
			.collect();
		samples.sort();
		samples[samples.len() / 2]
	};

	// The first ten leave inside 100ms, the last fifteen well after the step at 150ms.
	let before = latency(0..10);
	let after = latency(25..40);
	assert!(
		after > before + Duration::from_millis(30),
		"median latency went from {before:?} to {after:?}"
	);
}

#[tokio::test]
async fn tcp_passes_through_unimpaired() {
	// The relay serves /certificate.sha256 over HTTP on the same port number as QUIC,
	// and the browser fetches it before it opens WebTransport.
	let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
	let addr = listener.local_addr().unwrap();

	tokio::spawn(async move {
		let (mut stream, _) = listener.accept().await.unwrap();
		let mut buf = [0u8; 64];
		let size = stream.read(&mut buf).await.unwrap();
		stream.write_all(&buf[..size]).await.unwrap();
	});

	// A profile that would mangle datagrams, to show TCP does not go through it.
	let shape = Direction {
		delay: Duration::from_millis(50),
		loss: 1.0,
		..Default::default()
	};
	let shaper = start(upward("blackhole", 13, shape), addr, true).await;

	let mut client = TcpStream::connect(shaper.local_addr()).await.unwrap();
	client.write_all(b"/certificate.sha256").await.unwrap();

	let mut buf = [0u8; 64];
	let size = tokio::time::timeout(TIMEOUT, client.read(&mut buf))
		.await
		.unwrap()
		.unwrap();
	assert_eq!(&buf[..size], b"/certificate.sha256");

	let counters = shaper.report().up;
	assert_eq!(counters.delivered, 0, "TCP must not reach the datagram queue");
	assert_eq!(counters.dropped, 0);
}

#[tokio::test]
async fn the_builtin_profiles_all_load() {
	for name in Profile::names() {
		let profile = Profile::parse(name).unwrap();
		assert_eq!(profile.name, name);

		// Binding proves the profile is usable, not just parseable.
		let upstream = Upstream::start().await;
		let shaper = start(profile, upstream.addr, false).await;
		assert_eq!(shaper.report().profile, name);
	}
}

#[tokio::test]
async fn a_burst_window_releases_a_batch_that_never_fills() {
	let upstream = Upstream::start().await;
	let shape = Direction {
		burst: Some(Burst {
			count: 100,
			window: Duration::from_millis(80),
		}),
		..Default::default()
	};
	let shaper = start(upward("window", 17, shape), upstream.addr, false).await;

	let sent = blast(shaper.local_addr(), 3, Duration::ZERO).await;
	let arrived = settle(&shaper, &upstream, 3).await;

	assert_eq!(arrived.len(), 3);
	let held = arrived[0].1.duration_since(sent[0]);
	assert!(held >= Duration::from_millis(80), "the batch left after only {held:?}");
}
