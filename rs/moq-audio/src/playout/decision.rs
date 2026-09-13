//! What to do with the next block of playout.
//!
//! Mirrors `decision_logic.cc`. One call per block, and the answer is always one of
//! a handful of operations: play the audio as it stands, play it slightly faster or
//! slower to move the buffer level toward the target, or make audio up because there
//! is none.
//!
//! The level it decides on is filtered ([`level`](super::level)) rather than raw: a
//! single late arrival is not a reason to speed the stream up. Operations are also
//! rate limited, because the audible cost of a splice is paid per splice, not per
//! millisecond moved.

use std::time::Duration;

use super::level::Level;
use super::{BLOCK, MAX_LAG, frames};

/// How far above the level playout holds the buffer may sit before it speeds up.
///
/// The estimator's own resolution: an estimate that rounded up does not read as a
/// buffer that needs draining. NetEq's `kDelayAdjustmentGranularityMs`.
const SLACK: Duration = Duration::from_millis(20);

/// Output between two operations, NetEq's `kMinTimescaleInterval` in wall time.
///
/// A splice is audible in proportion to how often it happens, and the level filter
/// needs time to see what the last one did.
const COOLDOWN: Duration = Duration::from_millis(100);

/// How far above the high threshold a buffer has to sit before playout stops being
/// polite about it, NetEq's fast accelerate.
const FAST: usize = 4;

/// What playout should do with the next block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
	/// Play the audio as it stands.
	Normal,
	/// Drop a pitch period to catch up, `fast` for a buffer so far above target that
	/// one period at a time never would.
	Accelerate { fast: bool },
	/// Repeat a pitch period, so the buffer is given time to refill before it runs
	/// out rather than after.
	Expand,
	/// There is nothing to play: conceal.
	Conceal,
	/// Audio is back after a concealment: splice it on.
	Merge,
}

/// The per-block decision loop for one stream.
pub(crate) struct Decision {
	rate: u32,
	level: Level,
	/// The playout target, in frames.
	target: usize,
	/// The most recent arrival, in frames, and the term on top of the target that
	/// makes the level playout holds. See [`Self::hold`].
	chunk: usize,
	/// Output since the last operation, in frames.
	since: usize,
	/// Whether the last block was concealed, so the next real audio is a splice.
	concealing: bool,
	/// Whether the buffer ran dry, so playout holds until it is back on target.
	stalled: bool,
}

impl Decision {
	/// A decision loop for `rate`, starting at the default target.
	pub(crate) fn new(rate: u32, target: Duration) -> Self {
		let mut level = Level::new();
		level.target(target);

		Self {
			rate,
			level,
			target: frames(rate, target),
			chunk: frames(rate, BLOCK),
			since: usize::MAX / 2,
			concealing: false,
			stalled: true,
		}
	}

	/// Follow a new target.
	pub(crate) fn target(&mut self, target: Duration) {
		self.level.target(target);
		self.target = frames(self.rate, target);
	}

	/// Note how much audio arrived in one go, which is the chunk playout holds on top
	/// of the target.
	///
	/// The most recent arrival, not a running maximum: one oversized decode would
	/// otherwise deepen playout for the life of the stream, and a publisher that
	/// changes its frame duration is described within one arrival. Never below one
	/// output block, since that is the least playout can take at a time.
	pub(crate) fn arrived(&mut self, count: usize) {
		let block = frames(self.rate, BLOCK);
		self.chunk = count.clamp(block, frames(self.rate, super::delay::CEILING));
	}

	/// The audio playout holds ahead of the playhead, in frames.
	///
	/// The target counts the frame being played, the way NetEq's does (its buffer
	/// level is the `packet_buffer` span plus what the sync buffer still holds), so
	/// what is still waiting to be played is the target plus one chunk. Playout
	/// refills to this after a stall and a flush drops back to it; holding the target
	/// alone leaves nothing unplayed, and the first arrival a millisecond late runs
	/// the buffer dry again.
	pub(crate) fn hold(&self) -> usize {
		self.target + self.chunk
	}

	/// The level at which playout starts speeding up, in frames.
	pub(crate) fn high(&self) -> usize {
		self.hold() + frames(self.rate, SLACK)
	}

	/// How much audio may sit ahead of the playhead before it is dropped rather than
	/// played late: the level playout would speed up at, plus what one time stretch
	/// can absorb.
	pub(crate) fn ceiling(&self) -> usize {
		self.high() + frames(self.rate, super::STRETCH_BOUND)
	}

	/// Decide what to do with the next block.
	///
	/// `ready` is the contiguous audio held, `queued` what is committed but not yet
	/// played, and `contiguous` whether what is held continues what was last played.
	pub(crate) fn decide(&mut self, ready: usize, queued: usize, contiguous: bool) -> Action {
		let block = frames(self.rate, BLOCK);
		self.level.update(ready + queued, 0);
		let level = self.level.filtered();

		// Too little to play is a stall whatever caused it, and audio that does not
		// continue what was played is a splice rather than a stall: the merge is
		// what carries the playhead over the hole.
		if ready < block {
			self.stalled = true;
			return Action::Conceal;
		}

		// A buffer that ran dry refills to the level playout holds before playing
		// again. Resuming on whatever arrived first plays on an empty cushion, so the
		// next late arrival is another stall, which is what a viewer hears as a
		// stutter that never settles.
		if self.stalled {
			if ready < self.hold() {
				return Action::Conceal;
			}
			self.stalled = false;
		}
		if !contiguous || self.concealing {
			return Action::Merge;
		}

		let high = self.high();
		if level >= FAST * high && ready >= self.stretch_input() {
			// No cooldown: a buffer this far above target is going to be late
			// whatever politeness says.
			return Action::Accelerate { fast: true };
		}

		if self.since < frames(self.rate, COOLDOWN) {
			return Action::Normal;
		}

		if level > high && ready >= self.stretch_input() {
			return Action::Accelerate { fast: false };
		}

		// Below half the level it holds the buffer is not being refilled by a slow
		// path, it is empty, and stretching it thinner only delays the concealment
		// that is coming. NetEq holds decoding back at the same threshold.
		let hold = self.hold();
		if level < hold && level >= hold / 2 && ready >= self.stretch_input() {
			return Action::Expand;
		}

		Action::Normal
	}

	/// Frames a time stretch needs to work with: enough for the splice itself, and
	/// enough left over that the result still fills a block.
	pub(crate) fn stretch_input(&self) -> usize {
		2 * frames(self.rate, MAX_LAG) + frames(self.rate, BLOCK)
	}

	/// Record one produced block: `shift` is the frames a stretch removed (positive)
	/// or inserted (negative), and `concealed` whether it was made up.
	pub(crate) fn produced(&mut self, count: usize, shift: i64, concealed: bool) {
		self.level.update(self.level.filtered(), shift);
		self.since = match shift == 0 {
			true => self.since.saturating_add(count),
			false => 0,
		};
		self.concealing = concealed;
	}

	/// Start over: a flush, or a stream that restarted somewhere else.
	pub(crate) fn reset(&mut self, buffered: usize) {
		self.level.set(buffered);
		self.since = usize::MAX / 2;
		self.concealing = false;
		self.stalled = buffered < frames(self.rate, BLOCK);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const RATE: u32 = 48_000;
	const BLOCK_FRAMES: usize = 480;

	fn decision(target: Duration) -> Decision {
		Decision::new(RATE, target)
	}

	/// Settle the filter on a level, the way a steady stream does.
	fn settle(decision: &mut Decision, ready: usize) {
		decision.reset(ready);
		for _ in 0..200 {
			decision.decide(ready, 0, true);
			decision.produced(BLOCK_FRAMES, 0, false);
		}
	}

	/// The level playout holds for a target, with the default 10ms chunk on top.
	fn hold(target: Duration) -> usize {
		frames(RATE, target + BLOCK)
	}

	#[test]
	fn a_buffer_on_the_level_it_holds_plays_normally() {
		let mut decision = decision(Duration::from_millis(100));
		let ready = hold(Duration::from_millis(100));
		settle(&mut decision, ready);
		assert_eq!(decision.decide(ready, 0, true), Action::Normal);
	}

	#[test]
	fn a_buffer_above_the_slack_accelerates() {
		let target = Duration::from_millis(100);
		let mut decision = decision(target);
		let ready = frames(RATE, Duration::from_millis(200));
		settle(&mut decision, ready);
		assert_eq!(decision.decide(ready, 0, true), Action::Accelerate { fast: false });
	}

	#[test]
	fn an_operation_waits_out_its_cooldown() {
		let target = Duration::from_millis(100);
		let mut decision = decision(target);
		let ready = frames(RATE, Duration::from_millis(200));
		settle(&mut decision, ready);

		assert_eq!(decision.decide(ready, 0, true), Action::Accelerate { fast: false });
		decision.produced(BLOCK_FRAMES, 720, false);

		assert_eq!(
			decision.decide(ready, 0, true),
			Action::Normal,
			"spliced twice in a row"
		);
		for _ in 0..10 {
			decision.produced(BLOCK_FRAMES, 0, false);
		}
		assert_eq!(decision.decide(ready, 0, true), Action::Accelerate { fast: false });
	}

	#[test]
	fn a_buffer_far_above_target_skips_the_cooldown() {
		let target = Duration::from_millis(100);
		let mut decision = decision(target);
		let ready = frames(RATE, Duration::from_millis(2000));
		settle(&mut decision, ready);

		assert_eq!(decision.decide(ready, 0, true), Action::Accelerate { fast: true });
		decision.produced(BLOCK_FRAMES, 720, false);
		assert_eq!(decision.decide(ready, 0, true), Action::Accelerate { fast: true });
	}

	#[test]
	fn a_thinning_buffer_expands_before_it_runs_out() {
		let target = Duration::from_millis(200);
		let mut decision = decision(target);
		let ready = frames(RATE, Duration::from_millis(150));
		settle(&mut decision, ready);
		assert!(ready < hold(target));
		assert_eq!(decision.decide(ready, 0, true), Action::Expand);
	}

	#[test]
	fn a_nearly_empty_buffer_is_left_to_refill() {
		let target = Duration::from_millis(200);
		let mut decision = decision(target);
		let ready = frames(RATE, Duration::from_millis(50));
		settle(&mut decision, ready);
		assert_eq!(
			decision.decide(ready, 0, true),
			Action::Normal,
			"stretching a buffer this thin only delays the concealment"
		);
	}

	#[test]
	fn an_empty_buffer_conceals_and_the_return_merges() {
		let target = Duration::from_millis(100);
		let mut decision = decision(target);
		decision.reset(hold(target));

		assert_eq!(decision.decide(0, 0, true), Action::Conceal);
		decision.produced(BLOCK_FRAMES, 0, true);

		assert_eq!(decision.decide(hold(target), 0, true), Action::Merge);
	}

	/// Resuming on whatever arrived first plays on an empty cushion, so the next
	/// late arrival is another stall: the stutter a viewer hears never settles.
	#[test]
	fn a_dry_buffer_refills_to_the_level_it_holds_before_it_plays() {
		let target = Duration::from_millis(100);
		let mut decision = decision(target);
		decision.reset(hold(target));

		assert_eq!(decision.decide(0, 0, true), Action::Conceal);
		decision.produced(BLOCK_FRAMES, 0, true);

		let half = frames(RATE, Duration::from_millis(50));
		assert_eq!(
			decision.decide(half, 0, true),
			Action::Conceal,
			"played on half a cushion"
		);
		decision.produced(BLOCK_FRAMES, 0, true);

		// The target alone is still a chunk short of what playout holds, because the
		// target counts the chunk being played.
		assert_eq!(
			decision.decide(frames(RATE, target), 0, true),
			Action::Conceal,
			"played on the target alone"
		);
		decision.produced(BLOCK_FRAMES, 0, true);

		assert_eq!(decision.decide(hold(target), 0, true), Action::Merge);
	}

	#[test]
	fn audio_past_a_hole_is_a_splice() {
		let mut decision = decision(Duration::from_millis(100));
		let ready = frames(RATE, Duration::from_millis(100));
		decision.reset(ready);
		assert_eq!(decision.decide(ready, 0, false), Action::Merge);
	}

	#[test]
	fn a_publishers_flush_span_widens_the_slack() {
		let target = Duration::from_millis(100);
		let mut decision = decision(target);
		let tight = decision.high();

		decision.arrived(frames(RATE, Duration::from_millis(160)));
		assert!(decision.high() > tight);
		assert_eq!(decision.hold(), frames(RATE, Duration::from_millis(260)));

		let ready = frames(RATE, Duration::from_millis(280));
		settle(&mut decision, ready);
		assert_eq!(
			decision.decide(ready, 0, true),
			Action::Normal,
			"a 7 frame flush is not a path that needs draining"
		);
	}

	#[test]
	fn one_arrival_describes_the_chunk_rather_than_every_arrival_before_it() {
		let mut decision = decision(Duration::from_millis(100));
		decision.arrived(frames(RATE, Duration::from_millis(160)));
		decision.arrived(frames(RATE, Duration::from_millis(20)));
		assert_eq!(
			decision.hold(),
			frames(RATE, Duration::from_millis(120)),
			"one oversized decode deepened playout for the life of the stream"
		);
	}
}
