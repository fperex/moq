//! How much buffer playout needs, measured from when frames arrive.
//!
//! The algorithm is written down in `doc/concept/playout.md` and held to it by the
//! conformance corpus at `rs/moq-audio/tests/playout-01.json`, which the browser
//! estimator in `js/hang/src/container/jitter.ts` generates. Both languages are held
//! to the page rather than to each other.
//!
//! The design is WebRTC's NetEq (`modules/audio_coding/neteq/`:
//! `underrun_optimizer.cc`, `packet_arrival_history.cc`, `histogram.cc`,
//! `delay_manager.cc`, `delay_constraints.cc`), reimplemented in `f64` from the
//! described algorithm rather than ported: the fixed point exists for 2010-era DSPs
//! and is where a cross-language parity bug would live.
//!
//! Each frame is measured against the fastest recent arrival rather than against the
//! previous one, so a path that slowly gets worse reads as a delay climbing to its
//! real size instead of as a string of tiny inter-arrival deltas. Those delays feed a
//! histogram read at a high quantile, because network delay is one-sided and
//! heavy-tailed.

use std::collections::VecDeque;
use std::time::Duration;

/// Buckets in the histogram.
const BUCKETS: usize = 100;

/// The fraction of arrivals the target covers.
const QUANTILE: f64 = 0.95;

/// Steady-state forget factor, applied once per resampled observation rather than
/// per arrival. At 500ms per observation, old mass falls below the 5% tail in 15s.
/// A longer history buffers a recovered path for a minute after a temporary queue.
pub(crate) const FORGET: f64 = 0.9;

/// Cold-start ramp: the first observations replace the seeded prior instead of
/// nudging it.
const START_FORGET_WEIGHT: f64 = 2.0;

/// One observation per interval, the maximum delay seen in it.
const RESAMPLE: f64 = 500.0;

/// How much media the arrival reference covers. Measured on the media axis, not the
/// wall clock, so a stalled sender cannot age out the only arrivals the reference
/// has.
const WINDOW: f64 = 2000.0;

/// The target before any observation lands, when the publisher declares nothing:
/// NetEq's `kStartDelayMs`.
const START: f64 = 80.0;

/// How many empty intervals one arrival may decay. 60 intervals is 30s, past the
/// histogram's own memory, so a longer pause converges to the same near-reset for a
/// bounded amount of work.
const MAX_CATCHUP: usize = 60;

/// How long the target holds before it may step down again.
const LOWER_INTERVAL: f64 = 1000.0;

/// The share of the remaining distance one fall step closes.
///
/// Written as a divisor rather than an `f64` sixth so the floor below it lands on the
/// same bucket in every language. The limiter smooths reductions after the
/// histogram has released an old delay, while the playout buffer catches up.
pub(crate) const LOWER_DIVISOR: f64 = 6.0;

/// How long the target stays up after playout last ran dry, in milliseconds.
///
/// A run-dry says what the arrivals cannot: that this receiver stops, and nothing
/// says when it will stop again. The hold is how long that is believed. It has to
/// outlast the gap between the freezes that cause it, or the fall walks the target
/// back into the next one, and every second past that is latency paid by a receiver
/// that froze once.
pub(crate) const HOLD: f64 = 30_000.0;

/// Width of one histogram bucket in milliseconds, and the resolution of the target.
///
/// The target is always a whole number of buckets, so a consumer asking whether the
/// estimate really moved compares the change against this.
pub(crate) const BUCKET: f64 = 20.0;

/// The widest delay the histogram can hold, so the widest target it can produce.
///
/// An observation above this is dropped rather than clamped, which makes it a real
/// ceiling on the estimate rather than a saturation point.
pub(crate) const CEILING: Duration = Duration::from_millis((BUCKETS * BUCKET as usize) as u64);

/// One admitted arrival, on both axes in milliseconds.
#[derive(Clone, Copy)]
struct Arrival {
	timestamp: f64,
	arrival: f64,
}

/// What playout's run-dries asked for, in milliseconds on the arrival clock.
#[derive(Clone, Copy)]
struct Held {
	/// The target they asked for.
	level: f64,
	/// When that ask runs out.
	until: f64,
}

/// What the caller already knows about one arrival, beyond the two clocks it carries.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Observation {
	/// The frame came out of order, whatever its timestamp says.
	///
	/// It is excluded from both the reference and the histogram: its arrival is early
	/// relative to its timestamp, so counting it would add the media-time distance
	/// between the two into a delay measurement.
	pub reordered: bool,

	/// The receiver itself was blocked before this arrival, so the wait in it is not
	/// the path's.
	///
	/// The estimator infers the same thing from arrival spacing, but spacing alone
	/// cannot separate a blocked receiver from a bursty path; whoever watched the
	/// receiver can. Set it and the arrival reference is dropped, exactly as the
	/// reading-gap rule does.
	pub stalled: bool,
}

/// The playout target for one track, in milliseconds of buffer.
pub(crate) struct Jitter {
	/// Admitted arrivals within [`WINDOW`] of media, ascending by
	/// `arrival - timestamp`, so the front is the fastest recent arrival.
	min: VecDeque<Arrival>,

	/// The newest timestamp admitted so far. Anything not strictly newer is
	/// reordered.
	newest: Option<f64>,

	/// The last arrival admitted, on both axes, so the next one can tell a gap in
	/// this receiver's own reading from a gap on the path.
	previous: Option<Arrival>,

	/// Weighted probability per delay bucket, summing to 1.
	buckets: [f64; BUCKETS],

	/// Observations folded in so far, and the factor the next one decays by.
	adds: u64,
	forget: f64,

	/// The resample interval currently open, and the largest delay seen inside it.
	interval_start: Option<f64>,
	interval_max: f64,

	/// The quantile's upper edge, i.e. what the histogram currently asks for.
	optimal: Option<f64>,

	/// Whether the target is a measurement yet, or still the seeded prior.
	measured: bool,

	/// The published target, and when it last moved.
	target: f64,
	lowered: Option<f64>,

	/// The level playout's run-dries asked for, while their hold lasts.
	held: Option<Held>,
}

impl Jitter {
	/// An estimator seeded with a decaying prior, so a cold start has something to
	/// take a quantile of, and starting at NetEq's guess.
	pub(crate) fn new() -> Self {
		Self::seeded(Duration::ZERO)
	}

	/// The same, starting from what the publisher declares it flushes.
	///
	/// A publisher's flush span is exactly the quantity this goes on to measure,
	/// published by the only party that already knows it, so it is a better cold
	/// start than a constant. Never below NetEq's 80ms guess, because the network
	/// adds to a flush span rather than replacing it, and rounded up to a whole
	/// bucket so the first target reads on the same grid as every later one. It is
	/// a prior, not an observation: the first measurement replaces it outright,
	/// however far below it that lands.
	pub(crate) fn seeded(advertised: Duration) -> Self {
		let mut buckets = [0.0; BUCKETS];
		for (i, bucket) in buckets.iter_mut().enumerate() {
			*bucket = 0.5f64.powi(i as i32 + 1);
		}

		let start = (advertised.as_secs_f64() * 1000.0)
			.max(START)
			.min(BUCKETS as f64 * BUCKET);
		let start = (start / BUCKET).ceil() * BUCKET;

		Self {
			min: VecDeque::new(),
			newest: None,
			previous: None,
			buckets,
			adds: 0,
			forget: 0.0,
			interval_start: None,
			interval_max: 0.0,
			optimal: None,
			measured: false,
			target: start,
			lowered: None,
			held: None,
		}
	}

	/// Fold one frame into the estimate, given its media timestamp and the wall time
	/// it arrived, in milliseconds on a monotonic local clock.
	///
	/// What the caller knows and the two clocks do not show goes in `observation`:
	/// that the frame came out of order, or that the receiver itself was blocked
	/// before it landed. A frame whose timestamp is not strictly newer than the newest
	/// admitted one is treated as reordered whatever the caller says.
	pub(crate) fn observe(&mut self, timestamp: Duration, now: f64, observation: Observation) {
		// Milliseconds on both axes from here down, so the unit is visible in the
		// arithmetic. The two clocks are never compared: every formula below is a
		// difference of differences, so a constant offset between them cancels.
		let ts = timestamp.as_secs_f64() * 1000.0;

		if observation.reordered || self.newest.is_some_and(|newest| ts <= newest) {
			// Costing a reordered arrival as delay against loss is a separate step,
			// not yet written.
			self.publish(now);
			return;
		}
		self.newest = Some(ts);

		// The arrival clock is sampled by whoever calls this, so time that caller
		// spent not reading lands in the next arrival it stamps and looks exactly
		// like a slow path. An arrival that follows a gap in the reading longer than
		// one interval, and that covers less media than the gap was long, drops the
		// reference: the backlog behind it is then measured against the path as the
		// receiver can now see it. The media term is what separates the two, since a
		// 1 fps track is idle for longer than an interval on every arrival while its
		// timeline advances just as far. Dropping the reference and not the one
		// arrival is the point: every frame in a backlog is equally late against a
		// reference taken before the gap, so skipping the first would leave the
		// second to set the same interval maximum.
		//
		// A caller that watched the receiver knows this outright and says so, which is
		// the only way to tell a block shorter than the interval from a path that
		// flushes in bursts: the two have the same arrival spacing. The action is the
		// same either way.
		if observation.stalled {
			self.min.clear();
		} else if let Some(previous) = self.previous {
			let idle = now - previous.arrival;
			let progress = ts - previous.timestamp;
			if idle > RESAMPLE && idle - progress > RESAMPLE {
				self.min.clear();
			}
		}
		self.previous = Some(Arrival {
			timestamp: ts,
			arrival: now,
		});

		// Drop arrivals the timeline has moved past. The window is media, so this
		// prunes by how much content has been delivered rather than by how long the
		// receiver has been running.
		while self.min.front().is_some_and(|front| front.timestamp + WINDOW < ts) {
			self.min.pop_front();
		}

		// Maintain the monotone deque: anything at least as slow as this arrival can
		// never be the minimum again.
		while let Some(back) = self.min.back() {
			if now - ts > back.arrival - back.timestamp {
				break;
			}
			self.min.pop_back();
		}
		self.min.push_back(Arrival {
			timestamp: ts,
			arrival: now,
		});

		let reference = self.min.front().copied().expect("an arrival was just pushed");
		let delay = (now - reference.arrival - (ts - reference.timestamp)).max(0.0);

		self.resample(now, delay);
		self.publish(now);
	}

	/// Raise the target to cover the `gap` of audio playout just ran out of, and keep
	/// it up for a while.
	///
	/// A receiver that keeps freezing is a receiver the arrivals never convict: the
	/// wait in them is its own, and whoever watched it discounts it, so nothing about
	/// them says the buffer is too shallow. Running dry does. `now` is on the arrival
	/// clock.
	pub(crate) fn starved(&mut self, gap: Duration, now: f64) {
		// Exact for a whole number of nanoseconds, where `as_secs_f64() * 1000.0` rounds
		// twice and can land a hair above a bucket edge the ceiling below then counts.
		let gap = gap.as_nanos() as f64 / 1_000_000.0;

		// Playout ran dry holding what this target asked for, so covering the gap takes
		// the two together. A caller reporting the same run-dry twice passes only what
		// the target does not already cover, which is what lets each report be measured
		// from the target it finds.
		let level = ((self.target + gap) / BUCKET).ceil() * BUCKET;
		let level = level.min(BUCKETS as f64 * BUCKET);

		// A report inside a running hold can only raise its level, and every report
		// restarts it: the hold is measured from the last run-dry, not the first.
		let level = match self.held {
			Some(held) if now < held.until => held.level.max(level),
			_ => level,
		};
		self.held = Some(Held {
			level,
			until: now + HOLD,
		});

		self.publish(now);
	}

	/// Forget the arrival reference, keeping the measured distribution.
	///
	/// A discontinuity moves the media timeline underneath the measurement, so every
	/// arrival in the reference describes a timeline that no longer exists and the
	/// open interval spans the jump. The histogram holds delays, which the jump does
	/// not move, so it survives.
	pub(crate) fn reanchor(&mut self) {
		self.min.clear();
		self.newest = None;
		self.previous = None;
		self.interval_start = None;
		self.interval_max = 0.0;
	}

	/// The current target: enough buffer to play [`QUANTILE`] of arrivals on time.
	pub(crate) fn target(&self) -> Duration {
		Duration::from_secs_f64(self.target / 1000.0)
	}

	// Take at most one observation per RESAMPLE, the largest delay in the interval.
	// That decorrelates the observations and turns the forget factor into a
	// wall-clock time constant, so a 50 fps track and a 1 fps track converge at the
	// same speed.
	fn resample(&mut self, arrival: f64, delay: f64) {
		let start = *self.interval_start.get_or_insert(arrival);

		let elapsed = arrival - start;
		if elapsed > RESAMPLE {
			self.add(self.interval_max);

			// Intervals that passed with no arrival still decay. A normalised
			// histogram cannot forget without an observation, so a pause would
			// otherwise preserve whatever the path looked like before it; a timer
			// instead of this would be untestable and unportable.
			let empty = ((elapsed / RESAMPLE).floor() as i64 - 1).clamp(0, MAX_CATCHUP as i64);
			for _ in 0..empty {
				self.add(0.0);
			}

			self.interval_start = Some(arrival);
			self.interval_max = 0.0;
		}

		// The arrival that closed an interval belongs to the new one, not to the one
		// it closed.
		self.interval_max = self.interval_max.max(delay);
	}

	// Fold one resampled observation into the histogram and read the quantile back
	// out.
	fn add(&mut self, ms: f64) {
		let index = (ms / BUCKET).floor();

		// Past the histogram's range the observation is dropped rather than clamped
		// into the last bucket, so one absurd arrival cannot pin the target at the
		// ceiling for a whole minute.
		if index < BUCKETS as f64 {
			let index = index as usize;
			let forget = self.forget;
			for bucket in &mut self.buckets {
				*bucket *= forget;
			}
			self.buckets[index] += 1.0 - forget;

			self.adds += 1;
			// `2.0 / ((adds + 1) as f64)`: integer division here makes the start ramp
			// jump straight to a forget factor of 1.
			self.forget = (1.0 - START_FORGET_WEIGHT / ((self.adds + 1) as f64)).clamp(0.0, FORGET);

			// The bucket's upper edge, because the delay it holds is somewhere inside
			// it and covering the whole bucket is what covers the quantile. Read
			// inside the guard: a dropped observation leaves the histogram alone, so
			// re-reading the quantile would return what it already says, and before
			// the first real one it would publish the bare prior as though something
			// had measured it.
			self.optimal = Some((self.quantile() + 1) as f64 * BUCKET);
		}
	}

	// The lowest bucket whose tail mass has dropped to 1 - QUANTILE. Bucket 0 is
	// subtracted before the loop, not inside it, and the comparison is strict.
	fn quantile(&self) -> usize {
		let mut sum = 1.0 - self.buckets[0];
		let mut index = 0;
		while sum > 1.0 - QUANTILE && index < BUCKETS - 1 {
			index += 1;
			sum -= self.buckets[index];
		}
		index
	}

	fn publish(&mut self, now: f64) {
		// A run-dry's level stands until its hold runs out, and is gone for good after
		// that: from then on the fall below walks the target back toward what the
		// histogram asks for.
		if self.held.is_some_and(|held| now >= held.until) {
			self.held = None;
		}
		let held = self.held.map(|held| held.level);

		// A seed is a prior, not an observation. It holds the target until the
		// histogram has measured something, and the first measurement then replaces
		// it outright however far below it that lands: there is no earlier
		// measurement for the fall bound to protect, and walking down from a guess
		// keeps a viewer above their real buffer for tens of seconds. NetEq does the
		// same, replacing `kStartDelayMs` with the first optimal delay it gets rather
		// than approaching it (`delay_manager.cc`). A run-dry is not a guess, so it
		// can raise the prior before then, and the first measurement does not land
		// below it.
		let Some(optimal) = self.optimal else {
			if let Some(held) = held {
				self.target = self.target.max(held);
			}
			return;
		};

		// The held level is one more thing the target has to cover, exactly as though
		// the histogram had asked for it: the target rises to it at once, and comes
		// down through the same limiter once the hold lets it go.
		let optimal = held.map_or(optimal, |held| optimal.max(held));
		if !self.measured {
			self.measured = true;
			self.lowered = Some(now);
			self.target = optimal;
			return;
		}

		let current = self.target;

		if optimal >= current {
			// Rise at once: a late frame has already proven the buffer is too
			// shallow, and waiting costs an underrun the viewer hears. The
			// histogram's range bounds how far one observation can take it.
			self.lowered = Some(now);
			self.target = optimal.max(current);
			return;
		}

		// Fall once a second, in as many steps as the elapsed time allows so a 1 fps
		// track and a 50 fps one shrink at the same wall-clock rate. Shrinking faster
		// drops the playhead onto a buffer the network has not refilled yet.
		//
		// Each step closes a share of the distance left rather than a fixed bucket,
		// because what a buffer can refill in a second scales with what it is
		// holding: a bucket out of 80ms is a quarter of it and a bucket out of 1600ms
		// is nothing, so a fixed step brakes hardest exactly where the target is
		// furthest from what the histogram asks for. The bucket stays as the floor,
		// since below its own resolution the target cannot move at all.
		let lowered = *self.lowered.get_or_insert(now);
		let steps = ((now - lowered) / LOWER_INTERVAL).floor();
		if steps <= 0.0 {
			return;
		}

		self.lowered = Some(lowered + steps * LOWER_INTERVAL);
		let mut target = current;
		for _ in 0..steps as u64 {
			if target <= optimal {
				break;
			}
			let share = ((target - optimal) / LOWER_DIVISOR / BUCKET).floor() * BUCKET;
			target = optimal.max(target - share.max(BUCKET));
		}
		self.target = target;
	}
}

impl Default for Jitter {
	fn default() -> Self {
		Self::new()
	}
}

/// What the caller allows the estimate to become, from `delay_constraints.cc`.
///
/// The estimator measures the network and carries no floor of its own. Everything
/// that is a policy rather than a measurement lives here: how much buffer the caller
/// insists on, how stale media may be before it is skipped instead of played, and
/// how much of what the buffer can physically hold playout may claim.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Constraints {
	/// The caller's floor: the target never lands under this.
	min: Duration,
	/// The age budget: media older than this is skipped, so buffering past it
	/// would hold audio that is going to be thrown away.
	max: Duration,
	/// NetEq's `kMaxNumberOfPackets` rule: playout may claim three quarters of what
	/// the buffer can hold, leaving a quarter for the arrivals that have to land
	/// while the deepest one is still playing.
	capacity: Duration,
}

impl Constraints {
	/// The share of the buffer playout may claim, NetEq's 75%.
	const SHARE: u32 = 3;

	/// Constraints for a caller wanting at least `min` of buffer, skipping media
	/// older than `max`, out of a buffer holding `capacity`.
	///
	/// Fails when the floor is above either ceiling: a floor deeper than the age
	/// budget asks to hold media the same config throws away, and one deeper than
	/// the buffer asks for audio there is nowhere to put. Both are contradictions a
	/// caller has to resolve, so neither is clamped silently.
	pub(crate) fn new(min: Duration, max: Duration, capacity: Duration) -> Result<Self, crate::Error> {
		let constraints = Self { min, max, capacity };
		let ceiling = constraints.ceiling();

		if min > ceiling {
			return Err(crate::Error::Unsupported(format!(
				"a playout delay of {min:?} does not fit: the age budget is {max:?} and the buffer holds {capacity:?}"
			)));
		}

		Ok(constraints)
	}

	/// The deepest target these constraints allow.
	///
	/// The budget has to stay a [`HEADROOM`](super::HEADROOM) above the target or it
	/// convicts the arrivals the target was sized to cover, so that much of it is not
	/// available to buffer with. At any budget worth running this is the looser of
	/// the two bounds and the 75% share is what binds; it is the tighter one on a
	/// budget too shallow for a quarter of itself to cover the headroom.
	fn ceiling(&self) -> Duration {
		self.max
			.saturating_sub(super::HEADROOM)
			.min(self.capacity * Self::SHARE / 4)
			.min(CEILING)
	}

	/// `target` held between the floor and the ceiling.
	pub(crate) fn apply(&self, target: Duration) -> Duration {
		target.clamp(self.min, self.ceiling().max(self.min))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Feed `count` frames at `spacing` milliseconds, arriving `delay` late.
	fn steady(jitter: &mut Jitter, count: usize, spacing: f64, delay: f64, from: f64) -> f64 {
		let mut now = from;
		for i in 0..count {
			let timestamp = Duration::from_secs_f64((from + i as f64 * spacing) / 1000.0);
			now = from + i as f64 * spacing + delay;
			jitter.observe(timestamp, now, Observation::default());
		}
		now
	}

	#[test]
	fn starts_at_the_guess() {
		let jitter = Jitter::new();
		assert_eq!(jitter.target(), Duration::from_millis(80));
	}

	/// A seed is a prior, not an observation. The first resampled observation lands
	/// half a second in and replaces it outright, however far below it that is: the
	/// fall bound exists to protect an earlier measurement and a declaration is not
	/// one. Walking a 320ms guess down instead leaves a viewer holding a buffer
	/// nothing measured asked for, for tens of seconds.
	#[test]
	fn the_first_measurement_replaces_a_declared_start() {
		let mut jitter = Jitter::seeded(Duration::from_millis(310));
		assert_eq!(jitter.target(), Duration::from_millis(320));

		// One second of evenly paced frames on a clean path.
		steady(&mut jitter, 50, 20.0, 50.0, 0.0);

		let measured = jitter.target();
		assert!(measured >= Duration::from_millis(20), "{measured:?}");
		assert!(measured <= Duration::from_millis(60), "{measured:?}");
	}

	/// Replacing the seed is a one-off. From the first measurement onwards the target
	/// is something an arrival proved, so it walks down at the ordinary bound rather
	/// than jumping to whatever the histogram last asked for.
	#[test]
	fn a_measured_target_still_falls_by_the_bound() {
		let mut jitter = Jitter::seeded(Duration::from_millis(310));

		// Two seconds of 7-frame bursts: the seed is long gone and the flush span is
		// measured.
		for i in 0..100u64 {
			let flush = (i / 7) * 7 + 6;
			jitter.observe(
				Duration::from_millis(i * 20),
				(flush * 20 + 50) as f64,
				Observation::default(),
			);
		}
		assert_eq!(jitter.target(), Duration::from_millis(140));

		// Then a clean path, whose quantile drops to one bucket long before the
		// target may.
		let start = 100 * 20;
		let mut previous = jitter.target();
		let mut bottom = None;

		for i in 0..1000u64 {
			let media = start + i * 20;
			jitter.observe(
				Duration::from_millis(media),
				(media + 50) as f64,
				Observation::default(),
			);

			let target = jitter.target();
			// A sixth of the distance left from 140ms is under a bucket, so the
			// bucket is the step.
			assert!(
				previous.saturating_sub(target) <= Duration::from_millis(BUCKET as u64),
				"fell {:?} at once",
				previous - target
			);
			previous = target;
			if bottom.is_none() && target == Duration::from_millis(BUCKET as u64) {
				bottom = Some(media);
			}
		}

		// Six buckets at a bucket a second: the fall cannot be quicker than that.
		let bottom = bottom.expect("the target never reached one bucket");
		assert!(bottom >= start + 6000, "reached one bucket after {}ms", bottom - start);
	}

	#[test]
	fn a_clean_path_falls_to_one_bucket() {
		let mut jitter = Jitter::new();
		steady(&mut jitter, 2000, 20.0, 0.0, 0.0);
		assert_eq!(jitter.target(), Duration::from_millis(20));
	}

	#[test]
	fn a_constant_path_delay_is_not_jitter() {
		let mut clean = Jitter::new();
		steady(&mut clean, 600, 20.0, 0.0, 0.0);

		let mut far = Jitter::new();
		steady(&mut far, 600, 20.0, 2000.0, 0.0);

		assert_eq!(clean.target(), far.target());
	}

	#[test]
	fn a_build_up_is_visible() {
		let mut jitter = Jitter::new();
		// Two milliseconds worse per frame, which an inter-arrival estimator reads
		// as a string of 2ms deltas.
		for i in 0..300 {
			let timestamp = Duration::from_millis(i * 20);
			jitter.observe(timestamp, (i * 20 + i * 2) as f64, Observation::default());
		}
		assert!(jitter.target() >= Duration::from_millis(200), "{:?}", jitter.target());
	}

	#[test]
	fn an_absurd_arrival_is_dropped() {
		let mut jitter = Jitter::new();
		let now = steady(&mut jitter, 600, 20.0, 0.0, 0.0);
		let settled = jitter.target();

		// 2500ms past the reference: above the histogram's range, so discarded.
		jitter.observe(
			Duration::from_secs_f64(now / 1000.0 + 0.02),
			now + 20.0 + 2500.0,
			Observation::default(),
		);
		// Close the interval it landed in.
		steady(&mut jitter, 60, 20.0, 0.0, now + 600.0);
		assert_eq!(jitter.target(), settled);
	}

	#[test]
	fn a_reordered_arrival_moves_nothing() {
		let mut jitter = Jitter::new();
		let now = steady(&mut jitter, 600, 20.0, 0.0, 0.0);
		let settled = jitter.target();

		// An old timestamp landing now would read as a delay the size of the gap
		// between the two if it were admitted.
		jitter.observe(Duration::from_millis(0), now + 10.0, Observation::default());
		assert_eq!(jitter.target(), settled);
	}

	/// A receiver that stops reading for a second and a half comes back to a backlog
	/// every frame of which is that late against a reference taken before the block.
	/// None of it came from the path, so none of it belongs in the target.
	#[test]
	fn a_gap_in_the_receivers_own_reading_is_not_the_paths_delay() {
		let mut jitter = Jitter::new();
		let mut now = steady(&mut jitter, 100, 20.0, 5.0, 0.0);
		let settled = jitter.target();

		// The reading loop blocks for 1500ms. The media kept coming, so it drains in
		// a few milliseconds a frame once the loop runs again.
		let mut ts = 2000.0;
		now += 1500.0;
		let mut peak = settled;
		for _ in 0..75 {
			jitter.observe(Duration::from_secs_f64(ts / 1000.0), now, Observation::default());
			peak = peak.max(jitter.target());
			ts += 20.0;
			now += 3.25;
		}

		// Then paced again, on a path that never changed.
		for _ in 0..200 {
			jitter.observe(Duration::from_secs_f64(ts / 1000.0), now + 5.0, Observation::default());
			peak = peak.max(jitter.target());
			ts += 20.0;
			now += 20.0;
		}

		// Nothing the block did reached the target, which without the rule would be
		// asking for the whole block and then walking it back down for a minute.
		assert_eq!(peak, settled, "the block raised the target");
		assert!(jitter.target() <= settled, "{:?}", jitter.target());
	}

	/// A block shorter than the resample interval has the same arrival spacing as a
	/// publisher flushing that often, so the spacing rule leaves it alone. A caller
	/// that watched its own receiver says so instead, and the target stays where the
	/// path put it.
	#[test]
	fn an_explicit_stall_is_not_the_paths_delay() {
		let block = 400.0;
		let drain = 2.0;

		let mut flagged = Jitter::new();
		let mut unflagged = Jitter::new();
		let mut now = steady(&mut flagged, 400, 20.0, 50.0, 0.0);
		steady(&mut unflagged, 400, 20.0, 50.0, 0.0);

		let settled = flagged.target();
		assert_eq!(settled, Duration::from_millis(BUCKET as u64));

		let mut cursor = now + block;
		let mut peak = settled;
		let mut control = settled;

		for i in 400..900u64 {
			let ts = (i * 20) as f64;
			// Read at the later of when the frame landed and when the loop got to it.
			let read = (ts + 50.0).max(cursor);
			// Every frame the loop was late to is one the loop was late to, not one the
			// path held.
			let stalled = read > ts + 50.0;
			cursor = read + drain;
			now = read;

			let timestamp = Duration::from_secs_f64(ts / 1000.0);
			flagged.observe(
				timestamp,
				read,
				Observation {
					stalled,
					..Default::default()
				},
			);
			unflagged.observe(timestamp, read, Observation::default());

			peak = peak.max(flagged.target());
			control = control.max(unflagged.target());
		}

		assert!(now > 0.0);
		assert_eq!(peak, settled, "the block raised the target");
		// The same arrivals with nothing watching the loop, which is what the flag is
		// worth: most of the block lands in the target and stays there.
		assert!(control >= Duration::from_millis(300), "{control:?}");
	}

	/// The media term is what tells the two apart: a track that genuinely sends one
	/// frame a second is idle for longer than an interval on every arrival, and its
	/// timeline advances just as far, so nothing is discounted.
	#[test]
	fn a_sparse_track_still_measures_its_path() {
		let mut jitter = Jitter::new();

		// One frame a second, arriving 150ms late every time.
		for i in 0..60u64 {
			let ts = (i * 1000) as f64;
			jitter.observe(Duration::from_secs(i), ts + 150.0, Observation::default());
		}

		// The path's own delay is steady, so the reference holds and the spread it
		// measures is the 150ms it really is rather than nothing at all.
		assert!(jitter.target() <= Duration::from_millis(40), "{:?}", jitter.target());
	}

	#[test]
	fn releases_a_temporary_queue_after_twenty_seconds_of_paced_arrivals() {
		let mut jitter = Jitter::new();
		for i in 0..6000u64 {
			jitter.observe(
				Duration::from_millis(i * 20),
				(i * 20 + 50) as f64,
				Observation::default(),
			);
		}
		for i in 0..300u64 {
			let timestamp = 120_000 + i * 20;
			let arrival = 120_000 + ((i / 25) + 1) * 500 + 50;
			jitter.observe(Duration::from_millis(timestamp), arrival as f64, Observation::default());
		}
		assert!(jitter.target() >= Duration::from_millis(480));

		for i in 0..1000u64 {
			let timestamp = 126_000 + i * 20;
			jitter.observe(
				Duration::from_millis(timestamp),
				(timestamp + 50) as f64,
				Observation::default(),
			);
		}
		assert!(jitter.target() <= Duration::from_millis(200), "{:?}", jitter.target());
	}

	/// A sixth of the distance left, floored to a bucket, with a bucket as the floor.
	/// The bound exists so the playhead is never handed a target the network has not
	/// refilled up to, and what a buffer refills in a second scales with what it
	/// holds, so the step does too.
	#[test]
	fn the_target_falls_by_a_share_of_the_distance_left() {
		let mut jitter = Jitter::new();

		// A publisher flushing 15 frames at a time, so the oldest frame of each
		// flush lands 280ms after it was made.
		for i in 0..150u64 {
			let arrival = ((i / 15) + 1) * 300;
			jitter.observe(Duration::from_millis(i * 20), arrival as f64, Observation::default());
		}
		let raised = jitter.target();
		assert!(raised >= Duration::from_millis(280), "{raised:?}");

		// Then it stops flushing and the target walks back down.
		let mut now = 3000.0;
		let mut fell = vec![raised];
		for i in 0..2000u64 {
			now = 3000.0 + (i * 20) as f64;
			jitter.observe(Duration::from_millis(3000 + i * 20), now, Observation::default());
			if i % 50 == 49 {
				fell.push(jitter.target());
			}
		}
		assert!(now > 3000.0);

		assert!(fell.last().unwrap() < &raised, "{fell:?}");
		for pair in fell.windows(2) {
			let step = pair[0].saturating_sub(pair[1]);
			let allowed = Duration::from_millis(
				((pair[0].as_millis() as f64 - 20.0) / LOWER_DIVISOR / BUCKET).floor() as u64 * BUCKET as u64,
			)
			.max(Duration::from_millis(BUCKET as u64));
			assert!(step <= allowed, "fell {step:?} in one second: {fell:?}");
		}

		// And while it is far from the quantile it comes down in more than a bucket a
		// second, which is the whole point: a fixed step takes eighty seconds to undo
		// a 1600ms overshoot, long after the histogram has forgotten what raised it.
		assert!(
			fell.windows(2)
				.any(|pair| pair[0].saturating_sub(pair[1]) > Duration::from_millis(BUCKET as u64)),
			"{fell:?}"
		);
		assert_eq!(fell.last(), Some(&Duration::from_millis(20)), "{fell:?}");
	}

	/// Where [`steady`] leaves the media timeline after `count` frames from `from`.
	fn after(count: usize, spacing: f64, from: f64) -> f64 {
		from + count as f64 * spacing
	}

	fn ms(value: u64) -> Duration {
		Duration::from_millis(value)
	}

	/// A clean path asks for one bucket. The receiver froze for 120ms with 40ms held, and the
	/// frames it was not reading are discounted as its own wait, so the 82ms the player ran dry is
	/// the only thing that says the target was too low.
	#[test]
	fn a_run_dry_raises_the_target_at_once() {
		let mut jitter = Jitter::new();
		let now = steady(&mut jitter, 500, 20.0, 50.0, 0.0);
		assert_eq!(jitter.target(), ms(20));

		jitter.starved(ms(82), now);
		assert_eq!(jitter.target(), ms(120));
	}

	#[test]
	fn a_run_dry_holds_the_target_until_hold_after_the_report_then_falls() {
		let mut jitter = Jitter::new();
		let at = steady(&mut jitter, 500, 20.0, 50.0, 0.0);
		jitter.starved(ms(82), at);

		let start = after(500, 20.0, 0.0);
		let mut previous = jitter.target();
		let mut bottom = None;
		for i in 0..((HOLD + 10_000.0) / 20.0) as u64 {
			let media = start + (i * 20) as f64;
			jitter.observe(
				Duration::from_secs_f64(media / 1000.0),
				media + 50.0,
				Observation::default(),
			);
			let target = jitter.target();

			if media + 50.0 < at + HOLD {
				assert_eq!(target, ms(120), "moved {}ms after the report", media + 50.0 - at);
			}
			assert!(
				previous.saturating_sub(target) <= ms(20),
				"fell {:?} at once",
				previous - target
			);
			previous = target;
			if bottom.is_none() && target == ms(20) {
				bottom = Some(media + 50.0);
			}
		}

		// Five buckets at a bucket a second, the first a second after the hold ends.
		let bottom = bottom.expect("the target never came back down");
		assert!(bottom >= at + HOLD + 5000.0 - 20.0, "{}", bottom - at);
		assert!(bottom <= at + HOLD + 5000.0 + 20.0, "{}", bottom - at);
	}

	/// The same run-dry reported again with nothing to add keeps the level and restarts the hold.
	#[test]
	fn a_report_restarts_the_hold_and_only_raises_the_level() {
		let mut jitter = Jitter::new();
		let now = steady(&mut jitter, 500, 20.0, 50.0, 0.0);
		jitter.starved(ms(82), now);
		assert_eq!(jitter.target(), ms(120));

		let now = steady(&mut jitter, 500, 20.0, 50.0, after(500, 20.0, 0.0));
		jitter.starved(Duration::ZERO, now);
		assert_eq!(jitter.target(), ms(120));

		let frames = ((HOLD - 1000.0) / 20.0) as usize;
		steady(&mut jitter, frames, 20.0, 50.0, after(1000, 20.0, 0.0));
		assert_eq!(jitter.target(), ms(120));

		steady(&mut jitter, 250, 20.0, 50.0, after(1000 + frames, 20.0, 0.0));
		assert!(jitter.target() < ms(120), "{:?}", jitter.target());
	}

	/// The first report covered the freeze but for 5ms, so the player still ran dry at the raised
	/// target: the next report is measured from there.
	#[test]
	fn a_later_run_dry_adds_to_the_target_it_raised() {
		let mut jitter = Jitter::new();
		let now = steady(&mut jitter, 500, 20.0, 50.0, 0.0);
		jitter.starved(ms(82), now);
		let now = steady(&mut jitter, 75, 20.0, 50.0, after(500, 20.0, 0.0));
		jitter.starved(ms(5), now);
		assert_eq!(jitter.target(), ms(140));
	}

	/// Once the arrivals ask for more than the held level on their own, the level decides nothing:
	/// the series is the one the same arrivals produce with no run-dry at all.
	#[test]
	fn the_histogram_above_the_held_level_decides() {
		let mut reported = Jitter::new();
		let mut control = Jitter::new();
		let now = steady(&mut reported, 100, 20.0, 50.0, 0.0);
		steady(&mut control, 100, 20.0, 50.0, 0.0);
		reported.starved(ms(40), now);
		assert_eq!(reported.target(), ms(60));

		let mut joined = false;
		for i in 0..((HOLD + 10_000.0) / 20.0) as u64 {
			let frame = 100 + i;
			// Seven frames flushed at once, the packing the public relay serves.
			let flushed = ((frame / 7) * 7 + 6) * 20 + 50;
			for jitter in [&mut reported, &mut control] {
				jitter.observe(ms(frame * 20), flushed as f64, Observation::default());
			}

			joined |= control.target() > ms(60);
			if joined {
				assert_eq!(reported.target(), control.target(), "frame {frame}");
			}
		}
		assert!(joined);
		assert_eq!(control.target(), ms(140));
	}

	/// A report before the first resample interval closes raises the prior, and the first
	/// measurement, which replaces a prior outright, does not replace a run-dry.
	#[test]
	fn the_first_measurement_does_not_land_below_a_running_hold() {
		let mut jitter = Jitter::new();
		jitter.observe(ms(0), 50.0, Observation::default());
		jitter.observe(ms(20), 70.0, Observation::default());
		assert_eq!(jitter.target(), ms(80));

		jitter.starved(ms(60), 80.0);
		assert_eq!(jitter.target(), ms(140));

		steady(&mut jitter, 50, 20.0, 50.0, 40.0);
		assert_eq!(jitter.target(), ms(140));

		let mut control = Jitter::new();
		steady(&mut control, 52, 20.0, 50.0, 0.0);
		assert_eq!(control.target(), ms(20));
	}

	/// The level an expired hold asked for is gone: a new report is measured from where the target
	/// has fallen to.
	#[test]
	fn an_expired_hold_starts_over_from_the_target() {
		let mut jitter = Jitter::new();
		let now = steady(&mut jitter, 500, 20.0, 50.0, 0.0);
		jitter.starved(ms(82), now);
		let frames = ((HOLD + 2500.0) / 20.0) as usize;
		let now = steady(&mut jitter, frames, 20.0, 50.0, after(500, 20.0, 0.0));
		assert_eq!(jitter.target(), ms(80));

		jitter.starved(ms(10), now);
		assert_eq!(jitter.target(), ms(100));
	}

	#[test]
	fn a_run_dry_never_raises_the_target_past_the_ceiling() {
		let mut jitter = Jitter::new();
		let now = steady(&mut jitter, 500, 20.0, 50.0, 0.0);
		jitter.starved(ms(5000), now);
		assert_eq!(jitter.target(), CEILING);
	}

	/// A discontinuity moves the timeline, not the player: what it ran dry at still stands.
	#[test]
	fn reanchoring_keeps_a_running_hold() {
		let mut jitter = Jitter::new();
		let now = steady(&mut jitter, 500, 20.0, 50.0, 0.0);
		jitter.starved(ms(82), now);

		// The media timeline jumps a hundred seconds ahead; the wall clock does not.
		jitter.reanchor();
		for i in 0..500u64 {
			let media = 110_000 + i * 20;
			jitter.observe(ms(media), now + 20.0 + (i * 20) as f64, Observation::default());
		}
		assert_eq!(jitter.target(), ms(120));
	}

	#[test]
	fn reanchoring_keeps_the_distribution() {
		let mut jitter = Jitter::new();
		steady(&mut jitter, 600, 20.0, 0.0, 0.0);
		let settled = jitter.target();

		jitter.reanchor();
		assert_eq!(jitter.target(), settled, "the histogram was thrown away");

		// A timeline that starts over somewhere else is measured from there.
		let now = steady(&mut jitter, 100, 20.0, 0.0, 100_000.0);
		assert!(now > 0.0);
		assert_eq!(jitter.target(), settled);
	}

	#[test]
	fn constraints_hold_the_target_between_the_floor_and_the_budget() {
		let constraints = Constraints::new(
			Duration::from_millis(100),
			Duration::from_millis(400),
			Duration::from_secs(2),
		)
		.unwrap();

		assert_eq!(constraints.apply(Duration::from_millis(20)), Duration::from_millis(100));
		assert_eq!(
			constraints.apply(Duration::from_millis(200)),
			Duration::from_millis(200)
		);
		// The budget, less the headroom it has to keep above whatever it allows.
		assert_eq!(
			constraints.apply(Duration::from_secs(1)),
			Duration::from_millis(400) - super::super::HEADROOM
		);
	}

	#[test]
	fn constraints_leave_a_quarter_of_the_buffer() {
		let constraints =
			Constraints::new(Duration::ZERO, Duration::from_secs(10), Duration::from_millis(400)).unwrap();
		assert_eq!(constraints.apply(Duration::from_secs(1)), Duration::from_millis(300));
	}

	/// The budget has to stay a headroom above whatever it allows, or it convicts the
	/// arrivals that target was sized to cover. On a budget too shallow for its own
	/// quarter to cover that, the headroom is what binds rather than the 75% share.
	#[test]
	fn constraints_leave_the_budget_its_headroom_above_the_target() {
		let shallow = Constraints::new(Duration::ZERO, Duration::from_millis(200), Duration::from_millis(200))
			.expect("no floor always fits");
		let target = shallow.apply(Duration::from_secs(1));
		assert_eq!(target, Duration::from_millis(200) - super::super::HEADROOM);
		assert!(target + super::super::HEADROOM <= Duration::from_millis(200));

		// Deep enough and the share is the tighter of the two again.
		let deep = Constraints::new(Duration::ZERO, Duration::from_secs(1), Duration::from_secs(1)).unwrap();
		assert_eq!(deep.apply(Duration::from_secs(2)), Duration::from_millis(750));
	}

	#[test]
	fn a_floor_above_the_budget_is_refused() {
		let err = Constraints::new(
			Duration::from_millis(500),
			Duration::from_millis(200),
			Duration::from_secs(2),
		)
		.unwrap_err();
		assert!(err.to_string().contains("500ms"), "{err}");

		// A budget has to be deeper than the floor by the headroom it keeps above it.
		Constraints::new(
			Duration::from_millis(500),
			Duration::from_millis(500) + super::super::HEADROOM,
			Duration::from_secs(2),
		)
		.unwrap();
	}
}
