//! A seeded userspace UDP shaper, so a test can put an impaired path in front of a relay.
//!
//! The shaper binds one socket, forwards every datagram to an upstream address after the
//! profile's treatment, and forwards the replies back. QUIC is indifferent to the extra
//! hop, so a browser or a native client reaches the relay through a path with delay,
//! jitter, loss, reorder, bunching, and a rate limit, with no capabilities and nothing
//! touching the host's network.
//!
//! Jitter is queueing delay on a FIFO path: it stretches and compresses the spacing
//! between datagrams, and never lets a later one overtake an earlier one. Only the
//! `reorder` draw does that, which is what keeps a reorder a deliberate act rather than a
//! side effect of the noise. A shaper that let jitter reorder would be read by QUIC as
//! loss, and the run would measure congestion response instead of the profile.
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

	/// Datagrams discarded because the token bucket's queue was already full.
	pub queue_dropped: u64,

	/// The most datagrams waiting for release at once.
	pub queue_max: usize,
}

/// A run's profile, seed, and per-direction counters.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Report {
	/// The profile that was active.
	pub profile: String,

	/// The profile seed both directions derived their own from.
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
			// One seed per direction, or the two lanes draw the same sequence and a symmetric
			// profile loses and reorders the same datagrams both ways. SmallRng runs the seed
			// through SplitMix64, so adjacent values start it well apart and the run still
			// replays from the profile's one seed.
			lanes: [
				Lane::new(profile.up.clone(), profile.seed, start),
				Lane::new(profile.down.clone(), profile.seed.wrapping_add(1), start),
			],
		}
	}

	/// Treat one datagram and queue it for release.
	fn accept(&mut self, dir: Dir, payload: Vec<u8>, socket: Arc<UdpSocket>, to: Option<SocketAddr>, now: Instant) {
		let start = self.start;
		let lane = &mut self.lanes[dir.index()];
		lane.step(start, now);

		// The treatment in force, copied out field by field so the lane stays free to count
		// while it is read. Every one of these is `Copy`; the schedule behind them is not.
		let Direction {
			delay,
			jitter,
			burst,
			loss: loss_rate,
			reorder: reorder_rate,
			reorder_delay,
			rate,
			..
		} = lane.shape;

		// Fixed draw order, every datagram, whether or not the knob is on: that is what
		// makes a seed replay the same decisions.
		let loss: f64 = lane.rng.random();
		let spread = gaussian(&mut lane.rng);
		let reorder: f64 = lane.rng.random();

		if loss < loss_rate {
			lane.counters.dropped += 1;
			return;
		}

		let wait = delay.as_secs_f64() + jitter.as_secs_f64() * spread;
		let mut release = now + Duration::from_secs_f64(wait.max(0.0));

		if let Some(rate) = rate {
			lane.refill(now);
			let owed = payload.len() as f64 - lane.tokens;

			// Debt is the backlog: bytes already promised that the rate has yet to earn. A
			// link with a finite queue tail-drops rather than growing that backlog forever,
			// so a datagram that would not fit is discarded here and counted apart from the
			// loss draw.
			if let Some(queue_bytes) = rate.queue_bytes
				&& owed > queue_bytes as f64
			{
				lane.counters.queue_dropped += 1;
				return;
			}

			lane.tokens -= payload.len() as f64;

			// Debt is also how long the bucket has to refill before this datagram may leave.
			if lane.tokens < 0.0 {
				release = release.max(now + Duration::from_secs_f64(owed / rate.bytes_per_second as f64));
				lane.counters.rate_limited += 1;
			}
		}

		// The lane is a queue, so a datagram leaves no earlier than the one in front of it:
		// jitter varies the spacing, never the order. The front advances by this datagram's
		// own release, before any reorder delay, so the datagram it is meant to fall behind
		// is not dragged along with it.
		release = release.max(lane.last_release);
		lane.last_release = release;

		if reorder < reorder_rate {
			release += reorder_delay;
			lane.counters.reordered += 1;
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

		match burst {
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
	/// The treatment in force, which each step revises part-way through the run.
	shape: Direction,

	/// The steps still pending, latest first, so the next one due is the last element.
	steps: Vec<Step>,

	rng: SmallRng,

	/// Bytes the token bucket has available, negative while it owes.
	tokens: f64,
	refilled: Instant,

	/// When the datagram in front of the queue leaves, which is the floor for the next one.
	last_release: Instant,

	/// The batch a burst profile is filling, and when it gives up waiting.
	held: Vec<Entry>,
	deadline: Option<Instant>,

	/// Datagrams held or queued right now, which is what `queue_max` peaks at.
	queued: usize,

	counters: Counters,
}

impl Lane {
	fn new(shape: Direction, seed: u64, start: Instant) -> Self {
		let mut steps = shape.steps.clone();
		steps.reverse();

		Self {
			steps,
			tokens: shape.rate.map_or(0.0, |rate| rate.burst_bytes as f64),
			shape,
			rng: SmallRng::seed_from_u64(seed),
			refilled: start,
			last_release: start,
			held: Vec::new(),
			deadline: None,
			queued: 0,
			counters: Counters::default(),
		}
	}

	/// Apply every step the run has reached, in order, each revising what it names.
	fn step(&mut self, start: Instant, now: Instant) {
		let elapsed = now.duration_since(start);

		while self.steps.last().is_some_and(|step| step.at <= elapsed) {
			let step = self.steps.pop().expect("peeked");

			// Settle the bucket at the old rate before the new one takes over, or the time
			// either side of the step refills at whichever rate happened to arrive last.
			self.refill(now);

			if let Some(delay) = step.delay {
				self.shape.delay = delay;
			}
			if let Some(jitter) = step.jitter {
				self.shape.jitter = jitter;
			}
			if let Some(loss) = step.loss {
				self.shape.loss = loss;
			}
			if let Some(rate) = step.rate {
				// A cap that was not there starts full, the way the run started. One that
				// was keeps its credit, clipped to the new bucket.
				self.tokens = match self.shape.rate {
					Some(_) => self.tokens.min(rate.burst_bytes as f64),
					None => rate.burst_bytes as f64,
				};
				self.shape.rate = Some(rate);
			}
		}
	}

	/// Credit the bucket for the time since it was last touched.
	fn refill(&mut self, now: Instant) {
		if let Some(rate) = self.shape.rate {
			let refill = now.duration_since(self.refilled).as_secs_f64() * rate.bytes_per_second as f64;
			self.tokens = (self.tokens + refill).min(rate.burst_bytes as f64);
		}

		self.refilled = now;
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

	/// Feed `count` numbered datagrams `spacing` apart, the way a live stream arrives.
	fn stream(state: &mut State, socket: &Arc<UdpSocket>, now: Instant, count: u32, spacing: Duration) {
		for id in 0..count {
			let at = now + spacing * id;
			state.accept(Dir::Up, id.to_be_bytes().to_vec(), socket.clone(), None, at);
		}
	}

	/// What the delivery loop would send by `until`, in the order it would send it.
	fn delivered(state: &mut State, until: Instant) -> Vec<(u32, Instant)> {
		state
			.due(until)
			.into_iter()
			.map(|entry| {
				let id = u32::from_be_bytes(entry.payload[..4].try_into().unwrap());
				(id, entry.at)
			})
			.collect()
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
	async fn jitter_alone_never_changes_the_order() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			delay: Duration::from_millis(5),
			jitter: Duration::from_millis(50),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		// Ten times the sigma of arrivals, so an independent draw per datagram would shuffle
		// nearly all of them. QUIC reads that as loss, retransmits, and the profile stops
		// measuring what it claims to.
		stream(&mut state, &socket, now, 2000, Duration::from_millis(5));

		let ids: Vec<u32> = delivered(&mut state, now + Duration::from_secs(60))
			.into_iter()
			.map(|(id, _)| id)
			.collect();

		assert_eq!(ids.len(), 2000);
		assert!(ids.is_sorted(), "jitter delivered datagrams out of order");
		assert_eq!(state.lanes[0].counters.reordered, 0, "nothing asked for a reorder");
	}

	#[tokio::test]
	async fn the_reorder_draw_is_the_only_thing_that_overtakes() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			delay: Duration::from_millis(5),
			jitter: Duration::from_millis(50),
			reorder: 0.05,
			reorder_delay: Duration::from_millis(40),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		stream(&mut state, &socket, now, 2000, Duration::from_millis(5));

		let ids: Vec<u32> = delivered(&mut state, now + Duration::from_secs(60))
			.into_iter()
			.map(|(id, _)| id)
			.collect();

		let overtaken = ids.windows(2).filter(|pair| pair[0] > pair[1]).count();
		assert!(overtaken > 0, "the reorder draw delivered everything in order anyway");
		assert!(state.lanes[0].counters.reordered > 0, "the reorder draw never fired");
	}

	#[tokio::test]
	async fn fifo_jitter_still_varies_the_spacing() {
		let socket = socket().await;
		let now = Instant::now();
		let spacing = Duration::from_millis(20);
		let shape = Direction {
			delay: Duration::from_millis(5),
			jitter: Duration::from_millis(5),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		stream(&mut state, &socket, now, 2000, spacing);

		let gaps: Vec<f64> = delivered(&mut state, now + Duration::from_secs(60))
			.windows(2)
			.map(|pair| pair[1].1.duration_since(pair[0].1).as_secs_f64())
			.collect();

		// Keeping the order is not the same as pacing the lane: a datagram that drew a
		// larger delay than the one in front still falls further behind it, and one that
		// drew a smaller delay closes up against it.
		let mean = gaps.iter().sum::<f64>() / gaps.len() as f64;
		let stddev = (gaps.iter().map(|gap| (gap - mean).powi(2)).sum::<f64>() / gaps.len() as f64).sqrt();
		assert!(stddev > 0.0, "every datagram arrived exactly {mean}s after the last");

		let spacing = spacing.as_secs_f64();
		assert!(gaps.iter().any(|&gap| gap < spacing), "nothing closed up");
		assert!(gaps.iter().any(|&gap| gap > spacing), "nothing fell behind");
	}

	#[tokio::test]
	async fn each_delay_step_applies_at_its_own_time() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			delay: Duration::from_millis(5),
			steps: vec![
				Step {
					at: Duration::from_millis(100),
					delay: Some(Duration::from_millis(60)),
					..Default::default()
				},
				Step {
					at: Duration::from_millis(200),
					delay: Some(Duration::from_millis(5)),
					..Default::default()
				},
			],
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		// One datagram per stretch, each drained before the next, so the release time read
		// off the queue is that datagram's own and not the one in front of it.
		let release = |state: &mut State, at: Instant| {
			state.accept(Dir::Up, vec![0; 16], socket.clone(), None, at);
			let leaves = state.queue.peek().expect("queued").at;
			state.due(leaves);
			leaves
		};

		assert_eq!(release(&mut state, now), now + Duration::from_millis(5));

		let during = now + Duration::from_millis(100);
		assert_eq!(release(&mut state, during), during + Duration::from_millis(60));

		// The step back restores the treatment the run opened with.
		let after = now + Duration::from_millis(200);
		assert_eq!(release(&mut state, after), after + Duration::from_millis(5));
	}

	#[tokio::test]
	async fn a_loss_step_turns_the_loss_draw_on_and_off_again() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			steps: vec![
				Step {
					at: Duration::from_secs(30),
					loss: Some(1.0),
					..Default::default()
				},
				Step {
					at: Duration::from_secs(60),
					loss: Some(0.0),
					..Default::default()
				},
			],
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		let stretch = |state: &mut State, at: Instant| {
			let before = state.lanes[0].counters.dropped;
			for _ in 0..100 {
				state.accept(Dir::Up, vec![0; 16], socket.clone(), None, at);
			}
			state.due(at);
			state.lanes[0].counters.dropped - before
		};

		assert_eq!(stretch(&mut state, now), 0, "the profile opens clean");
		assert_eq!(
			stretch(&mut state, now + Duration::from_secs(30)),
			100,
			"the step lost nothing"
		);
		assert_eq!(
			stretch(&mut state, now + Duration::from_secs(60)),
			0,
			"the step back never cleared"
		);
	}

	#[tokio::test]
	async fn a_rate_step_narrows_the_bucket_and_widens_it_again() {
		let socket = socket().await;
		let now = Instant::now();
		let wide = ByteRate {
			bytes_per_second: 4000,
			burst_bytes: 100,
			queue_bytes: None,
		};
		let narrow = ByteRate {
			bytes_per_second: 1000,
			burst_bytes: 100,
			queue_bytes: None,
		};
		let shape = Direction {
			rate: Some(wide),
			steps: vec![
				Step {
					at: Duration::from_secs(30),
					rate: Some(narrow),
					..Default::default()
				},
				Step {
					at: Duration::from_secs(60),
					rate: Some(wide),
					..Default::default()
				},
			],
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		// The bucket is full at each stretch, so the first 100 bytes are free and the next
		// 100 owe exactly one bucket's worth of refill at whichever rate is in force.
		let owed = |state: &mut State, at: Instant| {
			state.accept(Dir::Up, vec![0; 100], socket.clone(), None, at);
			state.accept(Dir::Up, vec![0; 100], socket.clone(), None, at);
			let release = state.queue.iter().map(|entry| entry.at).max().expect("queued");
			state.due(release);
			release.duration_since(at)
		};

		assert_eq!(owed(&mut state, now), Duration::from_millis(25));
		assert_eq!(
			owed(&mut state, now + Duration::from_secs(30)),
			Duration::from_millis(100)
		);
		assert_eq!(
			owed(&mut state, now + Duration::from_secs(60)),
			Duration::from_millis(25)
		);
	}

	#[tokio::test]
	async fn the_queue_cap_drops_what_will_not_fit_and_counts_it() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			rate: Some(ByteRate {
				bytes_per_second: 1000,
				burst_bytes: 100,
				queue_bytes: Some(200),
			}),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		// The first 100 bytes are free, the next 200 fill the queue, and everything after
		// that is tail-dropped until the bucket refills.
		for _ in 0..8 {
			state.accept(Dir::Up, vec![0; 100], socket.clone(), None, now);
		}

		let counters = state.lanes[0].counters;
		assert_eq!(counters.queue_dropped, 5, "the queue cap held the wrong backlog");
		assert_eq!(counters.rate_limited, 2, "only the queued datagrams owe the bucket");
		assert_eq!(counters.dropped, 0, "a tail drop is not a loss draw");
		assert_eq!(state.due(now + Duration::from_secs(1)).len(), 3);

		// A queue that has drained takes datagrams again, so the cap sheds a burst rather
		// than blackholing the lane.
		let later = now + Duration::from_secs(1);
		state.accept(Dir::Up, vec![0; 100], socket, None, later);
		assert_eq!(state.lanes[0].counters.queue_dropped, 5);
		assert_eq!(state.due(later).len(), 1);
	}

	#[tokio::test]
	async fn a_rate_without_a_queue_cap_never_drops() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			rate: Some(ByteRate {
				bytes_per_second: 1000,
				burst_bytes: 100,
				queue_bytes: None,
			}),
			..Default::default()
		};
		let mut state = State::new(&profile(shape), now);

		for _ in 0..8 {
			state.accept(Dir::Up, vec![0; 100], socket.clone(), None, now);
		}

		let counters = state.lanes[0].counters;
		assert_eq!(counters.queue_dropped, 0, "an uncapped queue tail-dropped");
		assert_eq!(counters.dropped, 0);
		assert_eq!(
			counters.rate_limited, 7,
			"every datagram past the burst owes the bucket"
		);
		assert_eq!(
			state.due(now + Duration::from_secs(1)).len(),
			8,
			"the lane held nothing back"
		);
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
				queue_bytes: None,
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
			let mut state = State::new(&profile(shape.clone()), now);
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

	#[tokio::test]
	async fn each_direction_draws_its_own_sequence() {
		let socket = socket().await;
		let now = Instant::now();
		let shape = Direction {
			loss: 0.5,
			..Default::default()
		};
		let profile = Profile {
			name: "test".to_string(),
			seed: 7,
			up: shape.clone(),
			down: shape,
		};
		let mut state = State::new(&profile, now);

		// The same datagrams both ways through the same treatment, so the only thing that can
		// tell the two lanes apart is the sequence each one draws. Recorded per datagram
		// rather than as a total, because two independent lanes can still drop the same count.
		let mut dropped = [Vec::new(), Vec::new()];
		for id in 0..64u32 {
			for dir in [Dir::Up, Dir::Down] {
				let before = state.lanes[dir.index()].counters.dropped;
				state.accept(dir, id.to_be_bytes().to_vec(), socket.clone(), None, now);
				let after = state.lanes[dir.index()].counters.dropped;
				dropped[dir.index()].push(after > before);
			}
		}

		assert!(
			dropped[0].iter().any(|&d| d),
			"the up lane never dropped, so the test proves nothing"
		);
		assert_ne!(dropped[0], dropped[1], "both directions drew the same sequence");
	}
}
