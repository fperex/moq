//! How full the buffer is, smoothed.
//!
//! Mirrors `buffer_level_filter.cc`. The decision loop must not chase every packet:
//! a single late arrival is not a reason to speed the stream up, and a single early
//! one is not a reason to slow it down. So the raw level goes through a one pole
//! filter first, slower the larger the target is, because a large target is one that
//! expects a wide arrival spread.
//!
//! The one thing that bypasses the filter is a time stretch: samples it just removed
//! or inserted are subtracted outright, so the operation is not counted twice while
//! the filter catches up and does it again.

use std::time::Duration;

/// The smoothed buffer level for one stream.
pub(crate) struct Level {
	filtered: f64,
	factor: f64,
}

/// How much of the old level survives each update, by target.
///
/// NetEq's Q8 factors of 251, 252, 253, and 254 out of 256.
fn factor(target: Duration) -> f64 {
	let steps = match target.as_millis() {
		0..=20 => 251.0,
		21..=60 => 252.0,
		61..=140 => 253.0,
		_ => 254.0,
	};
	steps / 256.0
}

impl Level {
	/// An empty filter, at NetEq's default factor.
	pub(crate) fn new() -> Self {
		Self {
			filtered: 0.0,
			factor: factor(Duration::from_millis(100)),
		}
	}

	/// Pick the smoothing for a new target delay.
	pub(crate) fn target(&mut self, target: Duration) {
		self.factor = factor(target);
	}

	/// Fold in the buffer level, in frames, less whatever a time stretch just moved.
	pub(crate) fn update(&mut self, buffered: usize, stretched: i64) {
		let filtered = self.factor * self.filtered + (1.0 - self.factor) * buffered as f64;
		self.filtered = (filtered - stretched as f64).max(0.0);
	}

	/// Jump straight to a level, for a change too large to filter: a flush, or a
	/// stream that restarted somewhere else.
	pub(crate) fn set(&mut self, buffered: usize) {
		self.filtered = buffered as f64;
	}

	/// The smoothed level, in frames.
	pub(crate) fn filtered(&self) -> usize {
		self.filtered.round() as usize
	}
}

impl Default for Level {
	fn default() -> Self {
		Self::new()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_factor_follows_the_target() {
		assert_eq!(factor(Duration::from_millis(20)), 251.0 / 256.0);
		assert_eq!(factor(Duration::from_millis(21)), 252.0 / 256.0);
		assert_eq!(factor(Duration::from_millis(60)), 252.0 / 256.0);
		assert_eq!(factor(Duration::from_millis(61)), 253.0 / 256.0);
		assert_eq!(factor(Duration::from_millis(140)), 253.0 / 256.0);
		assert_eq!(factor(Duration::from_millis(141)), 254.0 / 256.0);
		assert_eq!(factor(Duration::from_secs(2)), 254.0 / 256.0);
	}

	#[test]
	fn a_steady_buffer_converges_on_its_level() {
		let mut level = Level::new();
		level.target(Duration::from_millis(100));
		for _ in 0..2000 {
			level.update(960, 0);
		}
		assert!((level.filtered() as i64 - 960).abs() <= 1, "{}", level.filtered());
	}

	#[test]
	fn a_time_stretch_is_subtracted_once() {
		let mut level = Level::new();
		level.set(960);
		level.update(960, 240);
		assert_eq!(level.filtered(), 720);

		// And the next update does not pay for it again.
		level.update(720, 0);
		assert_eq!(level.filtered(), 720);
	}

	#[test]
	fn the_level_never_goes_negative() {
		let mut level = Level::new();
		level.set(100);
		level.update(100, 10_000);
		assert_eq!(level.filtered(), 0);
	}

	#[test]
	fn a_larger_target_moves_more_slowly() {
		let mut fast = Level::new();
		fast.target(Duration::from_millis(20));
		let mut slow = Level::new();
		slow.target(Duration::from_secs(1));

		for _ in 0..10 {
			fast.update(4800, 0);
			slow.update(4800, 0);
		}
		assert!(fast.filtered() > slow.filtered());
	}
}
