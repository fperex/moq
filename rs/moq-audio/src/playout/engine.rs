//! The jitter buffer itself: PCM in on the network's clock, PCM out on the device's.
//!
//! Mirrors `neteq_impl.cc`. Everything else in this module is a part; this is the
//! loop that runs them. [`Engine::insert`] takes decoded audio as it arrives and
//! [`Engine::pull`] fills exactly one [`BLOCK`] every time it is called, whatever
//! the network is doing, because the speaker is going to ask again in ten
//! milliseconds either way.
//!
//! What happens between the two is one decision per block
//! ([`decision`](super::decision)): play the audio as it stands, play it a little
//! faster or slower to walk the buffer toward the target the estimator measured
//! ([`delay`](super::delay)), or make audio up because there is none
//! ([`expand`](super::expand)) and splice the real thing back on when it returns
//! ([`merge`](super::merge)).

use std::collections::VecDeque;
use std::time::Duration;

use super::buffer::Buffer;
use super::decision::{Action, Decision};
use super::delay::{Constraints, Jitter};
use super::expand::Expand;
use super::merge::Merge;
use super::noise::Noise;
use super::stretch::{Stretch, Stretched};
use super::sync::Sync;
use super::{BLOCK, OVERLAP, frames};

/// Played audio kept for concealment to study, which has to cover what
/// [`Expand::analyse`] reads.
const HISTORY: Duration = Duration::from_millis(40);

/// How the engine is built.
#[derive(Clone, Debug)]
pub(crate) struct Config {
	/// Samples per second per channel, which is what the decoder emits.
	pub(crate) sample_rate: u32,
	/// Channels per frame, interleaved.
	pub(crate) channels: u32,
	/// The buffer the caller insists on, which the estimator may raise but never
	/// lowers past.
	pub(crate) delay: Duration,
	/// How stale media may be before it is skipped, which is the ceiling on the
	/// target: buffering past it holds audio the same budget throws away.
	pub(crate) max_age: Duration,
	/// Whether a gap is concealed with synthesized audio or played as a ramp into
	/// silence.
	pub(crate) conceal: bool,
}

/// What the engine has been doing.
///
/// Counted always and read by the tests; what a player reports to a viewer, and
/// through which type, is a decision for whoever builds that panel.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Stats {
	/// Blocks the engine had to invent because nothing was held.
	pub(crate) underruns: u64,
	/// Blocks that reached the device short, which is the invariant's own counter
	/// and should never move.
	pub(crate) short: u64,
	/// Blocks of concealment produced, including the ones a merge then spliced.
	pub(crate) expands: u64,
	/// Time stretches applied, in either direction.
	pub(crate) accelerates: u64,
	/// Times audio was dropped for sitting too far ahead of the playhead.
	pub(crate) skips: u64,
	/// Frames dropped by those skips.
	pub(crate) skipped: u64,
	/// The target the estimator currently asks for.
	pub(crate) target: Duration,
	/// Contiguous audio held, ahead of the playhead.
	pub(crate) buffered: Duration,
}

/// How much media one run of output frames carried, so the playhead can be read
/// back out of the queue rather than guessed at.
struct Segment {
	frames: usize,
	media: Duration,
}

/// A jitter buffer for one audio stream.
pub(crate) struct Engine {
	rate: u32,
	channels: usize,
	block: usize,
	conceal: bool,

	buffer: Buffer,
	sync: Sync,
	decision: Decision,

	stretch: Stretch,
	expand: Expand,
	merge: Merge,
	noise: Noise,

	jitter: Jitter,
	constraints: Constraints,
	target: Duration,

	/// Media time already committed to [`Self::sync`], and the newest timestamp the
	/// estimator has seen.
	played: Option<Duration>,
	observed: Option<Duration>,

	/// Media carried by each run of committed frames, oldest first, and where the
	/// next frame to leave the engine sits on the media timeline.
	segments: VecDeque<Segment>,
	playhead: Option<Duration>,

	/// Concealed blocks produced back to back, for the ramp a caller who turned
	/// concealment off hears instead.
	silence: u32,

	/// Reused between blocks so a pull allocates nothing once it is warm.
	scratch: Vec<f32>,
	produced: Vec<f32>,
	concealed: Vec<f32>,

	stats: Stats,
}

impl Engine {
	/// Build an engine, failing when the caller's floor does not fit under its own
	/// age budget.
	pub(crate) fn new(config: Config) -> Result<Self, crate::Error> {
		let rate = config.sample_rate;
		let channels = config.channels.max(1) as usize;
		if rate == 0 {
			return Err(crate::Error::Unsupported("sample rate must be > 0".into()));
		}

		// What the buffer can hold is the age budget: media older than that is
		// skipped upstream, so it is also the deepest playout could ever fill.
		let constraints = Constraints::new(config.delay, config.max_age, config.max_age)?;
		let target = constraints.apply(Duration::from_millis(80));

		Ok(Self {
			rate,
			channels,
			block: frames(rate, BLOCK),
			conceal: config.conceal,
			buffer: Buffer::new(rate, channels),
			sync: Sync::new(rate, channels, HISTORY),
			decision: Decision::new(rate, target),
			stretch: Stretch::new(rate, channels),
			expand: Expand::new(rate, channels),
			merge: Merge::new(rate, channels),
			noise: Noise::new(channels),
			jitter: Jitter::new(),
			constraints,
			target,
			played: None,
			observed: None,
			segments: VecDeque::new(),
			playhead: None,
			silence: 0,
			scratch: Vec::new(),
			produced: Vec::new(),
			concealed: Vec::new(),
			stats: Stats::default(),
		})
	}

	/// Frames the sink pulls per call, which is one block at the engine's rate.
	pub(crate) fn block(&self) -> usize {
		self.block
	}

	/// Fold one frame's arrival into the target estimate.
	///
	/// Call it where the frames are read off the wire, before anything can decide a
	/// group is too old to decode: a target measured from what survives an age
	/// budget only ever confirms the budget it was cut to. `now` is milliseconds on
	/// any monotonic local clock.
	pub(crate) fn observe(&mut self, timestamp: Duration, now: f64) {
		self.jitter.observe(timestamp, now, false);
		self.observed = Some(self.observed.map_or(timestamp, |newest| newest.max(timestamp)));
		self.retarget();
	}

	/// Hold decoded PCM, which starts at media time `timestamp` and arrived at
	/// `now`.
	///
	/// The arrival is only measured here if [`observe`](Self::observe) has not
	/// already seen this frame: decode is downstream of the age budget, so the
	/// earlier observation is the better one.
	pub(crate) fn insert(&mut self, timestamp: Duration, now: f64, pcm: &[f32]) {
		if self.observed.is_none_or(|newest| timestamp > newest) {
			self.observe(timestamp, now);
		}

		let count = pcm.len() / self.channels;
		self.decision.arrived(count);
		self.buffer.insert(timestamp, pcm);
		self.playhead
			.get_or_insert_with(|| self.buffer.front().unwrap_or(timestamp));

		// A burst far past anything playout will reach is dropped here rather than
		// played late, which is the delay the target exists to bound.
		let dropped = self.flush();
		self.record_skip(dropped);
	}

	/// A timeline discontinuity: everything held describes a timeline that no longer
	/// exists.
	pub(crate) fn reanchor(&mut self) {
		self.jitter.reanchor();
		self.buffer.clear();
		self.sync.flush();
		self.expand.reset();
		self.noise.reset();
		self.decision.reset(0);
		self.segments.clear();
		self.played = None;
		self.observed = None;
		self.playhead = None;
	}

	/// Fill `out` with exactly one block of playout, whatever the network is doing.
	///
	/// `out` must hold one block of interleaved frames, which is what
	/// [`block`](Self::block) reports.
	pub(crate) fn pull(&mut self, out: &mut [f32]) {
		debug_assert_eq!(out.len(), self.block * self.channels);

		while self.sync.queued() < self.block {
			self.produce();
		}

		if !self.sync.pull(out) {
			// The loop above cannot leave the buffer short, so this is the counter
			// that says so rather than a path with behaviour.
			out.fill(0.0);
			self.stats.short += 1;
			return;
		}

		self.advance(self.block);
	}

	/// Where playout has reached on the media timeline, or `None` before anything
	/// has been held.
	///
	/// This is the clock video follows: it counts the media that has actually left
	/// for the speaker, so a time stretch or a concealment moves it by what it
	/// really moved rather than by the block it produced.
	pub(crate) fn playhead(&self) -> Option<Duration> {
		self.playhead
	}

	/// Whether there is no media left to play: nothing held, and nothing committed
	/// but unheard. What is left from here is concealment for audio that is not
	/// coming.
	///
	/// The queue itself is not the test. Concealment commits a block plus the
	/// overlap the next splice would be aligned against, so a run of it leaves a tail
	/// queued forever; that tail carries no media, which is what makes it the thing
	/// to stop on rather than the thing to wait for.
	pub(crate) fn drained(&self) -> bool {
		self.buffer.ready() == 0 && self.segments.iter().all(|segment| segment.media.is_zero())
	}

	/// What the engine has been doing.
	#[cfg(test)]
	pub(crate) fn stats(&self) -> Stats {
		Stats {
			target: self.target,
			buffered: self.buffer.buffered(),
			..self.stats
		}
	}

	/// The target the estimator asks for, held inside the caller's constraints.
	pub(crate) fn target(&self) -> Duration {
		self.target
	}

	/// The audio playout holds ahead of the playhead: the target plus the chunk being
	/// played, which is what a listener actually waits. See [`Decision::hold`].
	fn hold(&self) -> Duration {
		self.buffer.duration(self.decision.hold().max(self.block))
	}

	// Drop audio sitting so far ahead of the playhead that playing it would be late,
	// back to the level playout holds, and report the frames thrown away.
	//
	// One rule for both ends. The decision loop's own skip ceiling is the threshold, so
	// a target that has fallen does not suddenly convict audio the loop was about to
	// stretch away, and the buffer's flush keeps NetEq's multiple of the level underneath
	// that, so a ceiling that just narrowed does not either.
	fn flush(&mut self) -> usize {
		let ceiling = self.buffer.duration(self.decision.ceiling());
		self.buffer.flush(self.hold(), ceiling)
	}

	// Follow the estimator, which moves on every arrival.
	fn retarget(&mut self) {
		self.target = self.constraints.apply(self.jitter.target());
		self.decision.target(self.target);
	}

	// One turn of the decision loop, committing at least one block to the output.
	fn produce(&mut self) {
		let front = self.buffer.front();
		let contiguous = match (self.played, front) {
			(Some(played), Some(front)) => front <= played + self.buffer.duration(1),
			(None, Some(_)) => true,
			_ => false,
		};

		// Audio that has run too far ahead of the playhead is dropped back to the level
		// playout holds: it is going to be late either way, and playing it is the delay
		// the target exists to bound. The same rule as on the way in, so a target that
		// has just fallen does not convict from here what it tolerates there.
		let dropped = self.flush();
		if dropped > 0 {
			self.record_skip(dropped);
			self.decision.reset(self.buffer.ready());
		}

		let ready = self.buffer.ready();
		match self.decision.decide(ready, self.sync.queued(), contiguous) {
			Action::Normal => self.play(self.block),
			Action::Accelerate { fast } => self.accelerate(fast),
			Action::Expand => self.preemptive_expand(),
			Action::Conceal => self.conceal(ready == 0),
			Action::Merge => self.splice(),
		}
	}

	// Play what is held, as it stands.
	fn play(&mut self, count: usize) {
		self.scratch.clear();
		let start = self.buffer.front();
		let taken = self.buffer.take(count, &mut self.scratch);

		let media = self.buffer.duration(taken);
		let at = start.expect("audio was taken");
		self.played = Some(at + media);

		let pcm = std::mem::take(&mut self.scratch);
		self.noise.update(&pcm);
		self.commit(&pcm, media, 0, false);
		self.scratch = pcm;
	}

	// Drop a pitch period, so the buffer catches up on what it is holding.
	fn accelerate(&mut self, fast: bool) {
		self.scratch.clear();
		let start = self.buffer.front();
		let taken = self.buffer.take(self.decision.stretch_input(), &mut self.scratch);
		let media = self.buffer.duration(taken);
		self.played = Some(start.expect("audio was taken") + media);

		let input = std::mem::take(&mut self.scratch);
		self.noise.update(&input);
		self.produced.clear();
		let mut produced = std::mem::take(&mut self.produced);

		let shift = match self.stretch.accelerate(&input, &self.noise, fast, &mut produced) {
			Stretched::Applied { frames, .. } => {
				self.stats.accelerates += 1;
				frames as i64
			}
			Stretched::Skipped => {
				produced.extend_from_slice(&input);
				0
			}
		};

		self.commit(&produced, media, shift, false);
		self.produced = produced;
		self.scratch = input;
	}

	// Repeat a pitch period, giving the buffer time to refill before it runs dry
	// rather than after.
	fn preemptive_expand(&mut self) {
		self.scratch.clear();
		let start = self.buffer.front();
		let taken = self.buffer.take(self.decision.stretch_input(), &mut self.scratch);
		let media = self.buffer.duration(taken);
		self.played = Some(start.expect("audio was taken") + media);

		let input = std::mem::take(&mut self.scratch);
		self.noise.update(&input);
		self.produced.clear();
		let mut produced = std::mem::take(&mut self.produced);

		let shift = match self.stretch.preemptive_expand(&input, 0, &self.noise, &mut produced) {
			Stretched::Applied { frames, .. } => {
				self.stats.accelerates += 1;
				-(frames as i64)
			}
			Stretched::Skipped => {
				produced.extend_from_slice(&input);
				0
			}
		};

		self.commit(&produced, media, shift, false);
		self.produced = produced;
		self.scratch = input;
	}

	// Nothing to play: invent a block, or ramp into silence if the caller asked for
	// concealment to stay off.
	fn conceal(&mut self, underrun: bool) {
		if underrun {
			self.stats.underruns += 1;
		}

		self.produced.clear();
		let mut produced = std::mem::take(&mut self.produced);

		match self.conceal {
			true => {
				self.analyse();
				self.expand.process(&mut produced);
			}
			false => {
				self.gap(&mut produced);
				self.silence += 1;
			}
		}

		self.stats.expands += 1;
		self.commit(&produced, Duration::ZERO, 0, true);
		self.produced = produced;
	}

	// Audio is back. Splice it onto the concealment that covered for it, which is
	// also what carries the playhead over a hole the publisher left.
	fn splice(&mut self) {
		self.scratch.clear();
		let start = self.buffer.front();
		let taken = self.buffer.take(self.decision.stretch_input(), &mut self.scratch);
		let played = self.played;
		let at = start.expect("audio was taken");
		let media = self.buffer.duration(taken);

		// The hole the concealment covered is media nobody will ever hear, so the
		// playhead steps over it here rather than drifting by its length.
		let skipped = played.map_or(Duration::ZERO, |played| at.saturating_sub(played));
		self.played = Some(at + media);

		let input = std::mem::take(&mut self.scratch);
		self.noise.update(&input);
		self.produced.clear();
		let mut produced = std::mem::take(&mut self.produced);

		if self.conceal {
			// One block of concealment for the returning audio to be aligned and
			// crossfaded against, which is what makes the splice inaudible.
			self.analyse();
			self.concealed.clear();
			let mut concealed = std::mem::take(&mut self.concealed);
			self.expand.process(&mut concealed);
			let kept = self.merge.merge(&concealed, &input, &mut produced);
			self.concealed = concealed;

			self.commit(&produced, media + skipped, -(kept as i64), false);
		} else {
			// No concealment, so the return is a ramp up out of the silence that
			// stood in for it.
			produced.extend_from_slice(&input);
			let fade = frames(self.rate, OVERLAP).min(taken);
			for frame in 0..fade {
				let weight = 1.0 - super::fade(frame, fade);
				for index in 0..self.channels {
					produced[frame * self.channels + index] *= weight;
				}
			}
			self.commit(&produced, media + skipped, 0, false);
		}

		self.expand.reset();
		self.silence = 0;
		self.produced = produced;
		self.scratch = input;
	}

	// A ramp from the last thing played down to silence, for a caller that would
	// rather hear the gap than hear audio that was never sent.
	fn gap(&mut self, out: &mut Vec<f32>) {
		let start = out.len();
		out.resize(start + self.block * self.channels, 0.0);

		// Only the first block of a run ramps: after that there is nothing left to
		// ramp down from.
		if self.silence > 0 {
			return;
		}

		let fade = frames(self.rate, OVERLAP).min(self.block);
		let history = self.sync.history(1);
		let last: Vec<f32> = match history.len() == self.channels {
			true => history.to_vec(),
			false => vec![0.0; self.channels],
		};

		for frame in 0..fade {
			let weight = super::fade(frame, fade);
			for index in 0..self.channels {
				out[start + frame * self.channels + index] = last[index] * weight;
			}
		}
	}

	// Let concealment study the tail of the real signal, once it has one to study.
	fn analyse(&mut self) {
		if self.expand.consecutive() > 0 {
			return;
		}

		let history = self.expand.history();
		let recent = self.sync.history(history);
		if recent.len() / self.channels < history {
			return;
		}

		let recent = recent.to_vec();
		self.expand.analyse(&recent);
	}

	// Commit one run of output, recording how much media it carried so the playhead
	// stays on the media timeline rather than on the output one.
	fn commit(&mut self, pcm: &[f32], media: Duration, shift: i64, concealed: bool) {
		let count = pcm.len() / self.channels;
		debug_assert!(count >= self.block, "a produced block has to fill a pull");

		self.sync.push(pcm);
		self.segments.push_back(Segment { frames: count, media });
		self.decision.produced(count, shift, concealed);
	}

	// Move the playhead across `count` frames of output, pro rata through the runs
	// that carried them.
	fn advance(&mut self, count: usize) {
		let mut remaining = count;

		while remaining > 0 {
			let Some(segment) = self.segments.front_mut() else {
				break;
			};

			let taken = remaining.min(segment.frames);
			let media = segment.media.mul_f64(taken as f64 / segment.frames as f64);
			self.playhead = Some(self.playhead.unwrap_or_default() + media);

			segment.frames -= taken;
			segment.media = segment.media.saturating_sub(media);
			remaining -= taken;

			if segment.frames == 0 {
				self.segments.pop_front();
			}
		}
	}

	fn record_skip(&mut self, dropped: usize) {
		if dropped == 0 {
			return;
		}

		self.stats.skips += 1;
		self.stats.skipped += dropped as u64;
	}
}

#[cfg(test)]
mod tests {
	use super::super::fixture;
	use super::*;

	const RATE: u32 = 48_000;

	/// One 20 ms packet, which is what an Opus publisher sends.
	const PACKET: Duration = Duration::from_millis(20);

	fn config(channels: u32, conceal: bool) -> Config {
		Config {
			sample_rate: RATE,
			channels,
			delay: Duration::ZERO,
			max_age: Duration::from_millis(500),
			conceal,
		}
	}

	/// A scripted stream: what arrives, when, and what comes out.
	struct Player {
		engine: Engine,
		channels: usize,
		source: Vec<f32>,
		/// Wall clock, in milliseconds.
		now: f64,
		/// How fast the publisher's clock runs against ours: above one and media
		/// arrives faster than it is played, which is what a drifting device does.
		drift: f64,
		/// The next packet to deliver.
		next: usize,
		out: Vec<f32>,
	}

	impl Player {
		fn new(config: Config, seconds: f32) -> Self {
			let channels = config.channels as usize;
			let source = fixture::tone(RATE, seconds, 997.0, 0.5, channels);
			Self {
				engine: Engine::new(config).unwrap(),
				channels,
				source,
				now: 0.0,
				drift: 1.0,
				next: 0,
				out: Vec::new(),
			}
		}

		fn stereo(config: Config, seconds: f32) -> Self {
			let mut player = Self::new(config, seconds);
			player.source = fixture::antiphase(RATE, seconds, 997.0, 0.5);
			player
		}

		/// Where one packet sits on the media timeline, and its samples.
		fn packet(&self, index: usize) -> (Duration, &[f32]) {
			let count = frames(RATE, PACKET);
			let start = index * count * self.channels;
			let end = (start + count * self.channels).min(self.source.len());
			(PACKET * index as u32, &self.source[start.min(end)..end])
		}

		/// Deliver every packet the publisher has produced by now, `late` behind.
		fn deliver(&mut self, late: Duration) {
			let now = self.now;
			let produced = Duration::from_secs_f64(now * self.drift / 1000.0);
			loop {
				let (timestamp, pcm) = self.packet(self.next);
				if pcm.is_empty() || produced < timestamp + PACKET + late {
					break;
				}
				let pcm = pcm.to_vec();
				self.engine.insert(timestamp, now, &pcm);
				self.next += 1;
			}
		}

		/// Play `blocks` blocks, delivering packets as they are produced.
		fn play(&mut self, blocks: usize) {
			self.play_with(blocks, |_| Some(Duration::ZERO));
		}

		/// Play `blocks` blocks, asking `arrival` how late each block's deliveries
		/// are. `None` holds everything back, which is an outage.
		fn play_with(&mut self, blocks: usize, arrival: impl Fn(usize) -> Option<Duration>) {
			let mut out = vec![0.0; self.engine.block() * self.channels];

			for block in 0..blocks {
				if let Some(late) = arrival(block) {
					self.deliver(late);
				}
				self.engine.pull(&mut out);
				self.out.extend_from_slice(&out);
				self.now += BLOCK.as_secs_f64() * 1000.0;
			}
		}

		/// Hold every delivery until the buffer runs dry, returning where the
		/// concealment starts in the output.
		fn starve(&mut self) -> usize {
			let before = self.engine.stats().underruns;

			for _ in 0..400 {
				let at = self.out.len();
				self.play_with(1, |_| None);
				if self.engine.stats().underruns > before {
					return at;
				}
			}

			panic!("the buffer never ran dry");
		}

		/// The 100 ms of output starting at `from`.
		fn opening(&self, from: usize) -> &[f32] {
			&self.out[from..from + frames(RATE, Duration::from_millis(100)) * self.channels]
		}

		/// Output past `skip` blocks of warmup.
		fn played(&self, skip: usize) -> &[f32] {
			&self.out[skip * self.engine.block() * self.channels..]
		}
	}

	/// The one invariant the sink depends on: a block every time, whatever the
	/// network did.
	#[test]
	fn every_pull_fills_its_block() {
		let mut player = Player::new(config(1, true), 5.0);
		player.play_with(400, |block| match block {
			// An outage in the middle, and a burst when it ends.
			100..200 => None,
			_ => Some(Duration::ZERO),
		});

		assert_eq!(player.out.len(), 400 * frames(RATE, BLOCK));
		assert_eq!(player.engine.stats().short, 0);
	}

	#[test]
	fn a_steady_stream_holds_its_level() {
		let mut player = Player::new(config(1, true), 10.0);
		player.play(600);

		let stats = player.engine.stats();
		let target = player.engine.target();
		assert!(
			stats.buffered <= target + PACKET + Duration::from_millis(20),
			"{stats:?}"
		);
		assert_eq!(stats.skips, 0, "{stats:?}");

		// The warmup stall is the only concealment a clean path needs. It is measured from
		// the 80ms default target the estimator starts at rather than from where it
		// settles, plus the packet playout holds on top of it: the silence a listener
		// hears at the start is the refill to that level, not to the final one.
		let warmup = frames(RATE, Duration::from_millis(80) + PACKET + PACKET) / frames(RATE, BLOCK);
		let played = player.played(warmup);
		// A sine crosses zero exactly, so what a silent block looks like is a run,
		// not a sample.
		assert!(
			fixture::zero_run(played) < frames(RATE, BLOCK),
			"silence after the stream settled: {}",
			fixture::zero_run(played)
		);
		let dominant = fixture::dominant(played, RATE, 900.0, 1100.0);
		assert!((dominant - 997.0).abs() < 10.0, "{dominant}");
	}

	/// A buffer running ahead of the device drains by playing slightly faster, not
	/// by throwing audio away.
	#[test]
	fn a_buffer_above_target_accelerates_back_to_it() {
		let mut player = Player::new(config(1, true), 20.0);
		// A publisher whose clock runs 2% fast, which is a buffer that grows for a
		// reason no arrival timing can see.
		player.drift = 1.02;
		player.play(1000);

		let stats = player.engine.stats();
		assert!(stats.accelerates > 0, "{stats:?}");
		assert_eq!(
			stats.skips, 0,
			"the buffer was drained by throwing audio away: {stats:?}"
		);
		assert!(
			stats.buffered <= stats.target + PACKET + Duration::from_millis(95),
			"the buffer ran away: {stats:?}"
		);
	}

	/// The rare tail from the recorded traces: three outages, back to back, of the
	/// lengths a real relay produced, each one measured from where the buffer
	/// covering it ran out.
	#[test]
	fn the_recorded_gap_shape_never_goes_silent() {
		let mut player = Player::new(config(1, true), 30.0);
		player.play(300);

		for gap in [165, 220, 111] {
			let from = player.starve();
			player.play_with(gap / 10, |_| None);
			player.play(100);

			// Concealment holds the signal up while it lasts; a stream that never
			// comes back is muted toward the room on purpose, so what a gap must
			// never be is silent from the start.
			let opening = player.opening(from);
			assert_eq!(fixture::zero_run(opening), 0, "the {gap}ms gap opened with silence");
			assert!(fixture::energy(opening) > 0.01, "the {gap}ms gap opened quiet");
		}

		let stats = player.engine.stats();
		assert!(stats.expands > 0, "{stats:?}");
	}

	/// Concealment has to sound like the audio it stands in for, and the splice
	/// back has to be inaudible.
	#[test]
	fn a_gap_conceals_on_pitch_and_merges_without_a_step() {
		let mut player = Player::new(config(1, true), 20.0);
		player.play(300);

		let from = player.starve();
		player.play_with(4, |_| None);
		player.play(100);

		let played = player.opening(from);
		let dominant = fixture::dominant(played, RATE, 900.0, 1100.0);
		assert!(
			(dominant - 997.0).abs() < 20.0,
			"concealment drifted off pitch: {dominant}"
		);

		// The tone's own slope, at 997 Hz and 0.5 amplitude, is what a step is
		// measured against.
		let slope = 2.0 * std::f32::consts::PI * 997.0 / RATE as f32 * 0.5;
		let step = fixture::max_step(&player.out[from..]);
		assert!(step < slope * 3.0, "{step} against {slope}");
	}

	/// Both channels are spliced at the same point, so a correlated image stays
	/// correlated.
	#[test]
	fn an_antiphase_image_survives_concealment() {
		let mut player = Player::stereo(config(2, true), 20.0);
		player.play(300);

		let from = player.starve();
		player.play_with(6, |_| None);
		player.play(60);

		let played = player.opening(from);
		let sum: f32 = played.chunks_exact(2).map(|frame| (frame[0] + frame[1]).abs()).sum();
		let energy: f32 = played.chunks_exact(2).map(|frame| frame[0].abs()).sum();
		assert!(sum < energy * 0.1, "the image collapsed: {sum} against {energy}");
	}

	/// The caller who would rather hear the gap than hear audio nobody sent.
	#[test]
	fn concealment_off_plays_the_gap() {
		let mut player = Player::new(config(1, false), 20.0);
		player.play(300);
		let from = player.starve();
		player.play_with(6, |_| None);
		player.play(60);

		let silent = fixture::zero_run(player.opening(from));
		assert!(
			silent > frames(RATE, BLOCK) * 4,
			"the gap was concealed anyway: {silent}"
		);

		let mut concealed = Player::new(config(1, true), 20.0);
		concealed.play(300);
		let from = concealed.starve();
		concealed.play_with(6, |_| None);
		concealed.play(60);

		let run = fixture::zero_run(concealed.opening(from));
		assert!(run < frames(RATE, BLOCK), "concealment went silent: {run}");
	}

	/// The playhead is what video follows, so it only ever moves forward and it
	/// counts media rather than output.
	#[test]
	fn the_playhead_follows_the_media() {
		let mut player = Player::new(config(1, true), 8.0);
		player.play(50);
		let early = player.engine.playhead().expect("audio has played");

		player.play_with(30, |_| None);
		let during = player.engine.playhead().expect("audio has played");
		assert!(during >= early, "the playhead went backwards over a gap");

		player.play(100);
		let after = player.engine.playhead().expect("audio has played");
		assert!(after > during);
		assert!(after < Duration::from_millis(1600), "playout ran ahead of the media");
	}

	/// A floor the age budget cannot hold is a contradiction the caller has to
	/// resolve, not something to clamp quietly.
	#[test]
	fn a_delay_above_the_budget_is_refused() {
		let config = Config {
			delay: Duration::from_millis(400),
			max_age: Duration::from_millis(200),
			..config(1, true)
		};
		assert!(Engine::new(config).is_err());
	}
}
