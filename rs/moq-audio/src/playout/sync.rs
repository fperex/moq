//! Where a block lives between being decided and being played.
//!
//! Mirrors `sync_buffer.cc`. Every operation here writes whole pitch periods or whole
//! concealment blocks, none of which are the ten milliseconds the sink asks for, so
//! something has to hold the remainder. This is that something: a run of PCM with a
//! read cursor, keeping a little already played audio behind the cursor because
//! [`expand`](super::expand) and [`merge`](super::merge) both need recent history to
//! work from.
//!
//! It is also where the playhead comes from. [`Self::read`] counts every frame
//! committed to it and [`Self::queued`] counts the ones still waiting, so the media
//! position actually being heard is `read - queued`, which is what an A/V clock has
//! to steer video by. Reading the output frame count instead would drift by exactly
//! the amount every time stretch has moved.

use std::time::Duration;

use super::frames;

/// The engine's output block for one stream.
pub(crate) struct Sync {
	channels: usize,
	/// Interleaved PCM: history, then the cursor, then what is still to play.
	samples: Vec<f32>,
	/// Frame index of the next sample to play.
	cursor: usize,
	/// Played frames kept behind the cursor.
	history: usize,
	/// Frames committed since construction.
	read: u64,
	/// Frames played since construction.
	played: u64,
}

impl Sync {
	/// A buffer holding `history` of already played audio for concealment to study.
	pub(crate) fn new(rate: u32, channels: usize, history: Duration) -> Self {
		Self {
			channels: channels.max(1),
			samples: Vec::new(),
			cursor: 0,
			history: frames(rate, history),
			read: 0,
			played: 0,
		}
	}

	/// Commit interleaved PCM to be played after everything already queued.
	pub(crate) fn push(&mut self, pcm: &[f32]) {
		self.samples.extend_from_slice(pcm);
		self.read += (pcm.len() / self.channels) as u64;
		self.trim();
	}

	/// Play `out.len()` samples, or nothing at all if that many are not queued.
	pub(crate) fn pull(&mut self, out: &mut [f32]) -> bool {
		let wanted = out.len() / self.channels;
		if wanted > self.queued() {
			return false;
		}

		let start = self.cursor * self.channels;
		out.copy_from_slice(&self.samples[start..start + out.len()]);
		self.cursor += wanted;
		self.played += wanted as u64;
		self.trim();
		true
	}

	/// Frames committed but not played yet.
	pub(crate) fn queued(&self) -> usize {
		self.samples.len() / self.channels - self.cursor
	}

	/// Frames committed since construction. The media playhead is this less
	/// [`Self::queued`].
	pub(crate) fn read(&self) -> u64 {
		self.read
	}

	/// Frames played since construction.
	pub(crate) fn played(&self) -> u64 {
		self.played
	}

	/// The most recent `count` frames of played audio, for concealment to study.
	/// Shorter than asked for when that much has not been played yet.
	pub(crate) fn history(&self, count: usize) -> &[f32] {
		let count = count.min(self.cursor);
		&self.samples[(self.cursor - count) * self.channels..self.cursor * self.channels]
	}

	/// Drop everything, played and queued, keeping the frame counters.
	pub(crate) fn flush(&mut self) {
		self.samples.clear();
		self.cursor = 0;
	}

	/// Drop the queued audio without touching the history, for a stream that is about
	/// to be rebuilt from a different point.
	pub(crate) fn truncate(&mut self) {
		self.samples.truncate(self.cursor * self.channels);
	}

	/// Forget played audio past what concealment needs.
	fn trim(&mut self) {
		if self.cursor > self.history {
			let drop = self.cursor - self.history;
			self.samples.drain(..drop * self.channels);
			self.cursor -= drop;
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ramp(from: usize, count: usize) -> Vec<f32> {
		(from..from + count).map(|i| i as f32).collect()
	}

	#[test]
	fn plays_what_it_was_given_in_order() {
		let mut sync = Sync::new(48_000, 1, Duration::from_millis(30));
		sync.push(&ramp(0, 480));
		sync.push(&ramp(480, 480));
		assert_eq!(sync.queued(), 960);

		let mut out = vec![0.0; 480];
		assert!(sync.pull(&mut out));
		assert_eq!(out, ramp(0, 480));
		assert!(sync.pull(&mut out));
		assert_eq!(out, ramp(480, 480));
		assert_eq!(sync.queued(), 0);
		assert_eq!(sync.played(), 960);
	}

	#[test]
	fn refuses_a_pull_it_cannot_fill() {
		let mut sync = Sync::new(48_000, 1, Duration::from_millis(30));
		sync.push(&ramp(0, 240));

		let mut out = vec![0.0; 480];
		assert!(!sync.pull(&mut out));
		assert_eq!(sync.queued(), 240, "a refused pull consumes nothing");
		assert!(out.iter().all(|s| *s == 0.0));
	}

	#[test]
	fn the_playhead_is_what_has_been_read_less_what_is_queued() {
		let mut sync = Sync::new(48_000, 1, Duration::from_millis(30));
		sync.push(&ramp(0, 1440));
		assert_eq!(sync.read() - sync.queued() as u64, 0);

		let mut out = vec![0.0; 480];
		assert!(sync.pull(&mut out));
		assert_eq!(sync.read() - sync.queued() as u64, 480);
	}

	#[test]
	fn keeps_the_history_concealment_needs() {
		let mut sync = Sync::new(48_000, 1, Duration::from_millis(30));
		let mut out = vec![0.0; 480];
		for block in 0..10 {
			sync.push(&ramp(block * 480, 480));
			assert!(sync.pull(&mut out));
		}

		let history = sync.history(1440);
		assert_eq!(history.len(), 1440);
		assert_eq!(history, ramp(4800 - 1440, 1440));
		assert!(sync.history(4800).len() <= 1440, "history is bounded");
	}

	#[test]
	fn stereo_frames_stay_paired() {
		let mut sync = Sync::new(48_000, 2, Duration::from_millis(30));
		sync.push(&[1.0, -1.0, 2.0, -2.0]);
		assert_eq!(sync.queued(), 2);

		let mut out = vec![0.0; 4];
		assert!(sync.pull(&mut out));
		assert_eq!(out, vec![1.0, -1.0, 2.0, -2.0]);
	}

	#[test]
	fn truncate_keeps_the_history_and_drops_the_queue() {
		let mut sync = Sync::new(48_000, 1, Duration::from_millis(30));
		sync.push(&ramp(0, 960));
		let mut out = vec![0.0; 480];
		assert!(sync.pull(&mut out));

		sync.truncate();
		assert_eq!(sync.queued(), 0);
		assert_eq!(sync.history(480), ramp(0, 480));
	}
}
