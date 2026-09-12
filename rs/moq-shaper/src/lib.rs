//! A seeded userspace UDP shaper, so a test can put an impaired path in front of a relay.
//!
//! The shaper binds one socket, forwards every datagram to an upstream address after the
//! profile's treatment, and forwards the replies back. QUIC is indifferent to the extra
//! hop, so a browser or a native client reaches the relay through a path with delay,
//! jitter, loss, reorder, bunching, and a rate limit, with no capabilities and nothing
//! touching the host's network.
//!
//! One generator per direction, seeded from the profile, makes the decisions reproducible.
//! It does not make the kernel's delivery clock reproducible: a replayed run drops and
//! reorders the same datagrams, but the wall time each one lands is still the host's.

mod profile;

pub use profile::{Burst, ByteRate, Direction, Profile, Step};

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use rand::rngs::SmallRng;
use rand::{RngExt, SeedableRng};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::Notify;
use tokio::task::JoinSet;

/// The largest datagram the shaper will carry, which is larger than any QUIC packet.
const MAX_DATAGRAM: usize = 65535;

/// How long a client mapping survives without traffic. A QUIC connection that migrates
/// just allocates a new one.
const IDLE: Duration = Duration::from_secs(60);

/// Where the shaper listens, where it forwards, and how it treats the path between.
#[derive(Clone, Debug)]
pub struct Config {
	/// The address clients connect to instead of the upstream.
	pub listen: SocketAddr,

	/// The address every datagram is forwarded to.
	pub upstream: SocketAddr,

	/// The treatment applied in each direction.
	pub profile: Profile,

	/// Also proxy TCP on the listen port, unimpaired, so HTTP on that port still answers.
	pub tcp_passthrough: bool,
}

/// What the shaper did to one direction's datagrams.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Counters {
	/// Datagrams forwarded to the far side.
	pub delivered: u64,

	/// Datagrams discarded, by the loss draw or by a failed send.
	pub dropped: u64,

	/// Datagrams released later than they arrived.
	pub delayed: u64,

	/// Datagrams pushed back by the extra reorder delay.
	pub reordered: u64,

	/// Datagrams the token bucket pushed back.
	pub rate_limited: u64,

	/// The most datagrams waiting for release at once.
	pub queue_max: usize,
}

/// A run's profile, seed, and per-direction counters.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Report {
	/// The profile that was active.
	pub profile: String,

	/// The seed both directions were started from.
	pub seed: u64,

	/// Counters for datagrams travelling from the client to the upstream.
	pub up: Counters,

	/// Counters for datagrams travelling back from the upstream to the client.
	pub down: Counters,
}

/// An impaired UDP path in front of an upstream address.
pub struct Shaper {
	inner: Arc<Inner>,
	tcp: Option<TcpListener>,
	local: SocketAddr,
	profile: String,
	seed: u64,
}

impl Shaper {
	/// Bind the listen sockets, so a caller knows the port before anything is forwarded.
	pub async fn bind(config: Config) -> anyhow::Result<Self> {
		let socket = UdpSocket::bind(config.listen)
			.await
			.with_context(|| format!("failed to bind {}", config.listen))?;
		let local = socket.local_addr()?;

		// The relay serves HTTP on the same port number as QUIC, so the passthrough has
		// to land on the port the UDP socket actually got.
		let tcp = match config.tcp_passthrough {
			true => Some(
				TcpListener::bind(local)
					.await
					.with_context(|| format!("failed to bind the TCP passthrough on {local}"))?,
			),
			false => None,
		};

		let state = State::new(&config.profile, Instant::now());

		Ok(Self {
			inner: Arc::new(Inner {
				socket: Arc::new(socket),
				upstream: config.upstream,
				state: Mutex::new(state),
				wake: Notify::new(),
			}),
			tcp,
			local,
			profile: config.profile.name,
			seed: config.profile.seed,
		})
	}

	/// The address actually bound, which is what to hand a client when the port was 0.
	pub fn local_addr(&self) -> SocketAddr {
		self.local
	}

	/// A snapshot of what the shaper has done so far, readable while it runs.
	pub fn report(&self) -> Report {
		let state = self.inner.state.lock().unwrap();
		Report {
			profile: self.profile.clone(),
			seed: self.seed,
			up: state.lanes[Dir::Up.index()].counters,
			down: state.lanes[Dir::Down.index()].counters,
		}
	}

	/// Forward traffic until a socket fails or the returned future is dropped.
	pub async fn run(&self) -> anyhow::Result<()> {
		// Both live here rather than in `Inner` so dropping `run` drops the join set,
		// which aborts every per-client task. An `Inner` holding them would be a cycle.
		let clients = Mutex::new(HashMap::new());
		let tasks = Mutex::new(JoinSet::new());

		tokio::select! {
			res = self.deliver() => res,
			res = self.forward(&clients, &tasks) => res,
			res = self.expire(&clients) => res,
			res = self.passthrough(&tasks) => res,
		}
	}

	/// Read from the listen socket, treating each datagram as headed upstream.
	async fn forward(
		&self,
		clients: &Mutex<HashMap<SocketAddr, Client>>,
		tasks: &Mutex<JoinSet<()>>,
	) -> anyhow::Result<()> {
		let mut buf = vec![0u8; MAX_DATAGRAM];

		loop {
			let (size, from) = self
				.inner
				.socket
				.recv_from(&mut buf)
				.await
				.context("listen socket failed")?;
			let now = Instant::now();

			let known = {
				let mut clients = clients.lock().unwrap();
				clients.get_mut(&from).map(|client| {
					client.seen = now;
					client.socket.clone()
				})
			};

			// A 4-tuple the shaper has not seen gets its own upstream socket, so the
			// upstream sees one flow per client and a migration just allocates another.
			let socket = match known {
				Some(socket) => socket,
				None => {
					let socket = Arc::new(self.connect().await?);
					let task = tasks
						.lock()
						.unwrap()
						.spawn(backward(self.inner.clone(), socket.clone(), from));
					let client = Client {
						socket: socket.clone(),
						seen: now,
						task,
					};
					clients.lock().unwrap().insert(from, client);
					tracing::debug!(%from, "mapped a client");
					socket
				}
			};

			self.inner.accept(Dir::Up, buf[..size].to_vec(), socket, None, now);
		}
	}

	/// Pop each datagram at its release time and send it on.
	async fn deliver(&self) -> anyhow::Result<()> {
		loop {
			let wake = self.inner.state.lock().unwrap().wake();
			match wake {
				Some(at) => {
					let sleep = tokio::time::sleep_until(tokio::time::Instant::from_std(at));
					tokio::select! {
						_ = sleep => {},
						_ = self.inner.wake.notified() => {},
					}
				}
				None => self.inner.wake.notified().await,
			}

			let due = self.inner.state.lock().unwrap().due(Instant::now());
			if due.is_empty() {
				continue;
			}

			let mut sent = [0u64; 2];
			let mut failed = [0u64; 2];

			for entry in due {
				let res = match entry.to {
					Some(to) => entry.socket.send_to(&entry.payload, to).await,
					None => entry.socket.send(&entry.payload).await,
				};

				match res {
					Ok(_) => sent[entry.dir.index()] += 1,
					// The far side being gone is its problem, not a reason to stop shaping.
					Err(err) => {
						tracing::debug!(?err, "failed to forward a datagram");
						failed[entry.dir.index()] += 1;
					}
				}
			}

			let mut state = self.inner.state.lock().unwrap();
			for (lane, (sent, failed)) in state.lanes.iter_mut().zip(sent.into_iter().zip(failed)) {
				lane.counters.delivered += sent;
				lane.counters.dropped += failed;
			}
		}
	}

	/// Drop client mappings that have gone quiet, along with their sockets and tasks.
	async fn expire(&self, clients: &Mutex<HashMap<SocketAddr, Client>>) -> anyhow::Result<()> {
		let mut interval = tokio::time::interval(IDLE / 6);

		loop {
			interval.tick().await;
			let now = Instant::now();

			clients.lock().unwrap().retain(|from, client| {
				if now.duration_since(client.seen) < IDLE {
					return true;
				}
				tracing::debug!(%from, "expired an idle client");
				client.task.abort();
				false
			});
		}
	}

	/// Pump TCP straight through, unimpaired: see the README for why.
	async fn passthrough(&self, tasks: &Mutex<JoinSet<()>>) -> anyhow::Result<()> {
		let Some(listener) = &self.tcp else {
			return std::future::pending().await;
		};

		loop {
			let (client, _) = listener.accept().await.context("TCP passthrough failed")?;
			let upstream = self.inner.upstream;
			tasks.lock().unwrap().spawn(async move {
				if let Err(err) = pump(client, upstream).await {
					tracing::debug!(?err, "TCP passthrough connection failed");
				}
			});
		}
	}

	/// One upstream socket per client, connected so only the upstream can reply on it.
	async fn connect(&self) -> anyhow::Result<UdpSocket> {
		let any = match self.inner.upstream.ip() {
			IpAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
			IpAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
		};

		let socket = UdpSocket::bind(any)
			.await
			.context("failed to bind an upstream socket")?;
		socket
			.connect(self.inner.upstream)
			.await
			.with_context(|| format!("failed to connect to {}", self.inner.upstream))?;

		Ok(socket)
	}
}

/// The pieces a per-client task needs, so those tasks never borrow the shaper.
struct Inner {
	socket: Arc<UdpSocket>,
	upstream: SocketAddr,
	state: Mutex<State>,
	wake: Notify,
}

impl Inner {
	fn accept(&self, dir: Dir, payload: Vec<u8>, socket: Arc<UdpSocket>, to: Option<SocketAddr>, now: Instant) {
		self.state.lock().unwrap().accept(dir, payload, socket, to, now);
		self.wake.notify_one();
	}
}

/// One mapped client 4-tuple.
struct Client {
	socket: Arc<UdpSocket>,
	seen: Instant,
	task: tokio::task::AbortHandle,
}

/// Read the upstream's replies for one client and treat them as headed downstream.
async fn backward(inner: Arc<Inner>, upstream: Arc<UdpSocket>, client: SocketAddr) {
	let mut buf = vec![0u8; MAX_DATAGRAM];

	loop {
		let size = match upstream.recv(&mut buf).await {
			Ok(size) => size,
			// A connected UDP socket reports the upstream's ICMP rejections here. The
			// relay may simply not be listening yet, so keep the mapping.
			Err(err) if err.kind() == std::io::ErrorKind::ConnectionRefused => continue,
			Err(err) => {
				tracing::debug!(?err, %client, "upstream socket failed");
				return;
			}
		};

		let now = Instant::now();
		inner.accept(Dir::Down, buf[..size].to_vec(), inner.socket.clone(), Some(client), now);
	}
}

/// Copy bytes both ways between one accepted connection and the upstream.
async fn pump(mut client: TcpStream, upstream: SocketAddr) -> anyhow::Result<()> {
	let mut server = TcpStream::connect(upstream).await?;
	tokio::io::copy_bidirectional(&mut client, &mut server).await?;
	Ok(())
}

/// Which way a datagram is going.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dir {
	Up,
	Down,
}

impl Dir {
	fn index(self) -> usize {
		self as usize
	}
}

/// Everything the treatment and the delivery timer share.
struct State {
	/// Every datagram waiting for its release time, earliest first.
	queue: BinaryHeap<Entry>,

	/// Breaks ties in arrival order, so a reorder is only ever a deliberate act.
	seq: u64,

	/// When the run started, which is what a profile's step counts from.
	start: Instant,

	lanes: [Lane; 2],
}

impl State {
	fn new(profile: &Profile, start: Instant) -> Self {
		Self {
			queue: BinaryHeap::new(),
			seq: 0,
			start,
			lanes: [
				Lane::new(profile.up, profile.seed, start),
				Lane::new(profile.down, profile.seed, start),
			],
		}
	}

	/// Treat one datagram and queue it for release.
	fn accept(&mut self, dir: Dir, payload: Vec<u8>, socket: Arc<UdpSocket>, to: Option<SocketAddr>, now: Instant) {
		let start = self.start;
		let lane = &mut self.lanes[dir.index()];
		lane.step(start, now);

		let shape = lane.shape;

		// Fixed draw order, every datagram, whether or not the knob is on: that is what
		// makes a seed replay the same decisions.
		let loss: f64 = lane.rng.random();
		let spread = gaussian(&mut lane.rng);
		let reorder: f64 = lane.rng.random();

		if loss < shape.loss {
			lane.counters.dropped += 1;
			return;
		}

		let mut wait = shape.delay.as_secs_f64() + shape.jitter.as_secs_f64() * spread;
		if reorder < shape.reorder {
			wait += shape.reorder_delay.as_secs_f64();
			lane.counters.reordered += 1;
		}

		let mut release = now + Duration::from_secs_f64(wait.max(0.0));

		if let Some(rate) = shape.rate {
			let refill = now.duration_since(lane.refilled).as_secs_f64() * rate.bytes_per_second as f64;
			lane.tokens = (lane.tokens + refill).min(rate.burst_bytes as f64);
			lane.refilled = now;
			lane.tokens -= payload.len() as f64;

			// Debt is how long the bucket has to refill before this datagram may leave.
			if lane.tokens < 0.0 {
				let owed = -lane.tokens / rate.bytes_per_second as f64;
				release = release.max(now + Duration::from_secs_f64(owed));
				lane.counters.rate_limited += 1;
			}
		}

		self.seq += 1;
		let entry = Entry {
			at: release,
			arrived: now,
			seq: self.seq,
			dir,
			socket,
			to,
			payload,
		};

		lane.queued += 1;
		lane.counters.queue_max = lane.counters.queue_max.max(lane.queued);

		match shape.burst {
			Some(burst) => {
				if lane.held.is_empty() {
					lane.deadline = Some(now + burst.window);
				}
				lane.held.push(entry);
				if lane.held.len() >= burst.count {
					lane.flush(&mut self.queue);
				}
			}
			None => {
				if release > now {
					lane.counters.delayed += 1;
				}
				self.queue.push(entry);
			}
		}
	}

	/// When the delivery timer next has something to do.
	fn wake(&self) -> Option<Instant> {
		let held = self.lanes.iter().filter_map(|lane| lane.deadline);
		self.queue.peek().map(|entry| entry.at).into_iter().chain(held).min()
	}

	/// Every datagram whose release time has come, earliest first.
	fn due(&mut self, now: Instant) -> Vec<Entry> {
		for lane in &mut self.lanes {
			if lane.deadline.is_some_and(|deadline| deadline <= now) {
				lane.flush(&mut self.queue);
			}
		}

		let mut due = Vec::new();
		while self.queue.peek().is_some_and(|entry| entry.at <= now) {
			let entry = self.queue.pop().expect("peeked");
			self.lanes[entry.dir.index()].queued -= 1;
			due.push(entry);
		}

		due
	}
}

/// One direction's generator, token bucket, held batch, and counters.
struct Lane {
	/// The treatment in force, which a step replaces part-way through the run.
	shape: Direction,

	/// The step still pending, taken once the run reaches it.
	step: Option<Step>,

	rng: SmallRng,

	/// Bytes the token bucket has available, negative while it owes.
	tokens: f64,
	refilled: Instant,

	/// The batch a burst profile is filling, and when it gives up waiting.
	held: Vec<Entry>,
	deadline: Option<Instant>,

	/// Datagrams held or queued right now, which is what `queue_max` peaks at.
	queued: usize,

	counters: Counters,
}

impl Lane {
	fn new(shape: Direction, seed: u64, start: Instant) -> Self {
		Self {
			step: shape.step,
			tokens: shape.rate.map_or(0.0, |rate| rate.burst_bytes as f64),
			shape,
			rng: SmallRng::seed_from_u64(seed),
			refilled: start,
			held: Vec::new(),
			deadline: None,
			queued: 0,
			counters: Counters::default(),
		}
	}

	/// Apply the profile's step once the run has reached it.
	fn step(&mut self, start: Instant, now: Instant) {
		let Some(step) = self.step else { return };
		if now.duration_since(start) < step.at {
			return;
		}

		self.shape.delay = step.delay;
		self.shape.jitter = step.jitter;
		self.step = None;
	}

	/// Release the held batch, every datagram at the same instant.
	fn flush(&mut self, queue: &mut BinaryHeap<Entry>) {
		self.deadline = None;

		// The batch leaves no earlier than its latest member would have on its own.
		let Some(at) = self.held.iter().map(|entry| entry.at).max() else {
			return;
		};

		for mut entry in self.held.drain(..) {
			if at > entry.arrived {
				self.counters.delayed += 1;
			}
			entry.at = at;
			queue.push(entry);
		}
	}
}

/// One datagram waiting for its release time.
struct Entry {
	at: Instant,
	arrived: Instant,
	seq: u64,
	dir: Dir,
	socket: Arc<UdpSocket>,
	/// The destination, or `None` when the socket is already connected to it.
	to: Option<SocketAddr>,
	payload: Vec<u8>,
}

// `BinaryHeap` is a max-heap, so the ordering is reversed: earliest release first, and
// arrival order within the same instant.
impl Ord for Entry {
	fn cmp(&self, other: &Self) -> Ordering {
		other.at.cmp(&self.at).then_with(|| other.seq.cmp(&self.seq))
	}
}

impl PartialOrd for Entry {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialEq for Entry {
	fn eq(&self, other: &Self) -> bool {
		self.seq == other.seq
	}
}

impl Eq for Entry {}

/// A standard normal sample, Box-Muller, so the two draws per datagram are fixed.
fn gaussian(rng: &mut SmallRng) -> f64 {
	let u1: f64 = rng.random::<f64>().max(f64::MIN_POSITIVE);
	let u2: f64 = rng.random();
	(-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A socket the queued entries can carry. These tests never send, so one is enough.
	async fn socket() -> Arc<UdpSocket> {
		Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap())
	}

	fn profile(up: Direction) -> Profile {
		Profile {
			name: "test".to_string(),
			seed: 7,
			up,
			down: Direction::default(),
		}
	}

	#[tokio::test]
	async fn an_untreated_datagram_is_due_immediately() {
		let socket = socket().await;
		let now = Instant::now();
		let mut state = State::new(&profile(Direction::default()), now);
		state.accept(Dir::Up, vec![0; 16], socket, None, now);

		assert_eq!(state.due(now).len(), 1);
		assert_eq!(state.lanes[0].counters.delayed, 0);
		assert_eq!(state.lanes[0].counters.queue_max, 1);
	}

	#[tokio::test]
	async fn a_delayed_datagram_waits_for_its_release() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			delay: Duration::from_millis(20),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);
		state.accept(Dir::Up, vec![0; 16], socket, None, now);

		assert!(state.due(now).is_empty());
		assert_eq!(state.due(now + Duration::from_millis(20)).len(), 1);
		assert_eq!(state.lanes[0].counters.delayed, 1);
	}

	#[tokio::test]
	async fn jitter_never_delivers_a_datagram_before_it_arrived() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			jitter: Duration::from_millis(50),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		for _ in 0..1000 {
			state.accept(Dir::Up, vec![0; 16], socket.clone(), None, now);
		}

		// A negative total would panic in `Duration::from_secs_f64`, so reaching here at
		// all is half the assertion; the rest is that nothing leaves before it arrived.
		for entry in state.queue.iter() {
			assert!(entry.at >= entry.arrived);
		}
	}

	#[tokio::test]
	async fn a_step_replaces_the_delay_once_the_run_reaches_it() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			delay: Duration::from_millis(5),
			step: Some(Step {
				at: Duration::from_millis(100),
				delay: Duration::from_millis(60),
				jitter: Duration::ZERO,
			}),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		state.accept(Dir::Up, vec![0; 16], socket.clone(), None, now);
		assert_eq!(state.queue.peek().unwrap().at, now + Duration::from_millis(5));
		state.due(now + Duration::from_millis(5));

		let later = now + Duration::from_millis(100);
		state.accept(Dir::Up, vec![0; 16], socket, None, later);
		assert_eq!(state.queue.peek().unwrap().at, later + Duration::from_millis(60));
	}

	#[tokio::test]
	async fn a_burst_batch_releases_on_count_and_on_the_window() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			burst: Some(Burst {
				count: 3,
				window: Duration::from_millis(160),
			}),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		state.accept(Dir::Up, vec![0; 16], socket.clone(), None, now);
		state.accept(Dir::Up, vec![0; 16], socket.clone(), None, now);
		assert!(state.due(now).is_empty(), "a partial batch must not leak");

		state.accept(Dir::Up, vec![0; 16], socket.clone(), None, now);
		assert_eq!(state.due(now).len(), 3, "a full batch leaves together");

		// The window closes a batch that never fills.
		state.accept(Dir::Up, vec![0; 16], socket, None, now);
		assert!(state.due(now + Duration::from_millis(159)).is_empty());
		assert_eq!(state.due(now + Duration::from_millis(160)).len(), 1);
		assert_eq!(state.lanes[0].counters.queue_max, 3);
	}

	#[tokio::test]
	async fn the_token_bucket_spaces_datagrams_past_its_burst() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			rate: Some(ByteRate {
				bytes_per_second: 1000,
				burst_bytes: 100,
			}),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		// The first 100 bytes are free; the next 100 owe exactly 100ms of refill.
		state.accept(Dir::Up, vec![0; 100], socket.clone(), None, now);
		state.accept(Dir::Up, vec![0; 100], socket, None, now);

		assert_eq!(state.due(now).len(), 1);
		assert_eq!(state.lanes[0].counters.rate_limited, 1);
		assert!(state.due(now + Duration::from_millis(99)).is_empty());
		assert_eq!(state.due(now + Duration::from_millis(100)).len(), 1);
	}

	#[tokio::test]
	async fn the_same_seed_makes_the_same_decisions() {
		let socket = socket().await;
		let shape = Direction {
			delay: Duration::from_millis(5),
			jitter: Duration::from_millis(5),
			loss: 0.05,
			reorder: 0.05,
			reorder_delay: Duration::from_millis(20),
			..Default::default()
		};

		let decisions = |now| {
			let mut state = State::new(&profile(shape), now);
			for i in 0..1000u32 {
				state.accept(Dir::Up, i.to_be_bytes().to_vec(), socket.clone(), None, now);
			}
			let queued: Vec<_> = state.queue.iter().map(|entry| (entry.seq, entry.at)).collect();
			(state.lanes[0].counters, queued)
		};

		let now = Instant::now();
		let (first, first_queue) = decisions(now);
		let (second, second_queue) = decisions(now);

		assert_eq!(first, second);
		assert_eq!(first_queue, second_queue);
		assert!(first.dropped > 0 && first.reordered > 0);
	}
}
