//! What the stream sounds like when nobody is talking.
//!
//! Mirrors `background_noise.cc`. Two consumers: the time stretch asks for
//! [`Noise::energy`] to decide whether a block is speech or room tone, and
//! concealment asks for [`Noise::generate`] so a long outage fades into the room
//! rather than into silence.
//!
//! The estimate only moves on a window that is quieter than everything accepted so
//! far and whose spectrum is flat enough to be noise, which is what keeps a held
//! vowel or a sustained tone out of it. The acceptance threshold then climbs slowly
//! on every loud window, so a room that gets noisier is tracked within seconds
//! instead of being locked out forever.

use super::Rng;

/// Frames each update looks at. NetEq fixes this at 256 samples whatever the rate,
/// which is 5.3 ms at 48 kHz, and so do we.
const WINDOW: usize = 256;

/// Frames the residual energy is measured over, a quarter of the window.
const RESIDUAL: usize = 64;

/// Sample energy the estimate is never allowed under, `1.0` in NetEq's Q15 units.
const MIN_ENERGY: f32 = 1.0 / (32768.0 * 32768.0);

/// Starting acceptance threshold, NetEq's `500000` in Q15 units.
const THRESHOLD: f32 = 500_000.0 / (32768.0 * 32768.0);

/// Energy reported before anything has been estimated, NetEq's `75000` fixed
/// threshold in Q15 units. Roughly -42 dBFS, so an untrained engine treats anything
/// quieter than about -33 dBFS as passive.
const UNINITIALISED: f32 = 75_000.0 / (32768.0 * 32768.0);

/// Per update growth of the acceptance threshold, NetEq's `0.0035` in Q16. Four
/// hundred loud updates, so four seconds of 10 ms blocks, raise it by a factor 4.
const THRESHOLD_GROWTH: f32 = 1.0035;

/// The loudest window seen decays by this much per update, NetEq's `1023/1024`.
const MAX_DECAY: f32 = 1023.0 / 1024.0;

/// The threshold is never more than 60 dB under the loudest window, so a stream
/// that only ever gets louder still admits an estimate eventually.
const MAX_RATIO: f32 = 1.0 / 1_048_576.0;

/// How much residual a window must leave to count as noise rather than tone.
///
/// NetEq accepts when `5 * residual >= 16 * sample`, with the residual summed over
/// [`RESIDUAL`] frames and the sample energy averaged over [`WINDOW`], so as a ratio
/// of two averages that is `residual >= sample * 16 / (5 * 64)`. A first order
/// predictor takes 18 dB off a sine and almost nothing off white noise, which is the
/// whole point.
const FLATNESS: f32 = 16.0 / (5.0 * RESIDUAL as f32);

/// The background noise estimate for one stream.
pub(crate) struct Noise {
	channels: Vec<Channel>,
	initialised: bool,
	/// Carries the same excitation to every channel, as `expand.cc` does, so noise
	/// added to a correlated stereo image does not decorrelate it.
	shared: Vec<f32>,
}

/// One channel's estimate: a level, a one pole spectrum, and the search state that
/// decides when to replace them.
struct Channel {
	energy: f32,
	max_energy: f32,
	threshold: f32,
	reflection: f32,
	gain: f32,
	state: f32,
}

impl Noise {
	/// An estimate that reports the fixed floor until it sees a quiet window.
	pub(crate) fn new(channels: usize) -> Self {
		Self {
			channels: (0..channels.max(1)).map(|_| Channel::new()).collect(),
			initialised: false,
			shared: Vec::new(),
		}
	}

	/// Feed the most recent PCM, interleaved. Only the tail is looked at.
	pub(crate) fn update(&mut self, pcm: &[f32]) {
		let channels = self.channels.len();
		let total = pcm.len() / channels;
		let take = total.min(WINDOW);
		if take < RESIDUAL + 1 {
			return;
		}

		for (index, channel) in self.channels.iter_mut().enumerate() {
			let window: Vec<f32> = pcm[(total - take) * channels + index..]
				.iter()
				.step_by(channels)
				.copied()
				.collect();

			if channel.update(&window) {
				self.initialised = true;
			}
		}
	}

	/// Whether a quiet enough window has been seen yet.
	#[cfg(test)]
	pub(crate) fn initialised(&self) -> bool {
		self.initialised
	}

	/// Mean per sample energy of the background, or the fixed floor before the first
	/// estimate lands.
	pub(crate) fn energy(&self, channel: usize) -> f32 {
		match self.initialised {
			true => self.channels[channel.min(self.channels.len() - 1)].energy,
			false => UNINITIALISED,
		}
	}

	/// Write `out.len()` interleaved samples of background noise, scaled by `gain`.
	///
	/// Silence until the estimate initialises, matching NetEq: inventing a room tone
	/// we have never heard would be worse than the gap.
	pub(crate) fn generate(&mut self, out: &mut [f32], gain: f32, rng: &mut Rng) {
		let channels = self.channels.len();
		if !self.initialised {
			out.fill(0.0);
			return;
		}

		self.shared.clear();
		self.shared.extend((0..out.len() / channels).map(|_| rng.sample()));

		for (index, channel) in self.channels.iter_mut().enumerate() {
			for (frame, excitation) in self.shared.iter().enumerate() {
				channel.state = (channel.gain * excitation + channel.reflection * channel.state).clamp(-1.0, 1.0);
				out[frame * channels + index] = channel.state * gain;
			}
		}
	}

	/// Forget everything, for a stream that restarted somewhere else.
	pub(crate) fn reset(&mut self) {
		self.initialised = false;
		for channel in &mut self.channels {
			*channel = Channel::new();
		}
	}
}

impl Channel {
	fn new() -> Self {
		Self {
			energy: 2500.0 / (32768.0 * 32768.0),
			max_energy: 0.0,
			threshold: THRESHOLD,
			reflection: 0.0,
			gain: 0.0,
			state: 0.0,
		}
	}

	/// Returns whether this window replaced the estimate.
	fn update(&mut self, window: &[f32]) -> bool {
		let energy = window.iter().map(|x| x * x).sum::<f32>() / window.len() as f32;

		if energy >= self.threshold {
			// Loud window. Open the search up a little and remember the peak, so the
			// threshold tracks a room that got noisier instead of locking out.
			self.threshold *= THRESHOLD_GROWTH;
			self.max_energy *= MAX_DECAY;
			self.max_energy = self.max_energy.max(energy);
			self.threshold = self.threshold.max(self.max_energy * MAX_RATIO);
			return false;
		}

		// Quiet window: the level is worth having whatever the spectrum turns out to
		// be, so record it before the flatness test can reject the filter.
		self.threshold = energy.max(MIN_ENERGY);

		let r0: f32 = window.iter().map(|x| x * x).sum();
		if r0 <= 0.0 {
			return false;
		}
		let r1: f32 = window.windows(2).map(|w| w[0] * w[1]).sum();
		let reflection = (r1 / r0).clamp(-0.99, 0.99);

		let tail = &window[window.len() - RESIDUAL - 1..];
		let residual = tail
			.windows(2)
			.map(|w| {
				let e = w[1] - reflection * w[0];
				e * e
			})
			.sum::<f32>()
			/ RESIDUAL as f32;

		if residual < energy * FLATNESS {
			// Predictable, so tonal: a vowel or a whistle, not the room.
			return false;
		}

		self.energy = energy.max(MIN_ENERGY);
		self.reflection = reflection;
		self.gain = residual.sqrt();
		true
	}
}

#[cfg(test)]
mod tests {
	use super::super::fixture::{noise, tone};
	use super::*;

	/// A 48 kHz block long enough to update from.
	fn block(samples: &[f32]) -> Vec<f32> {
		samples.to_vec()
	}

	#[test]
	fn reports_the_floor_before_it_learns_anything() {
		let estimate = Noise::new(1);
		assert!(!estimate.initialised());
		assert_eq!(estimate.energy(0), UNINITIALISED);
	}

	#[test]
	fn converges_on_noise() {
		let mut estimate = Noise::new(1);
		let level = 0.01;
		let pcm = noise(48_000, 1.0, level, 1);

		for chunk in pcm.chunks(WINDOW) {
			estimate.update(&block(chunk));
		}

		assert!(estimate.initialised(), "a second of room tone should train it");

		// White noise at amplitude `level` has mean energy level^2 / 3.
		let expected = level * level / 3.0;
		let ratio = estimate.energy(0) / expected;
		assert!(
			ratio > 0.5 && ratio < 2.0,
			"energy {} vs {expected}",
			estimate.energy(0)
		);
	}

	#[test]
	fn does_not_track_a_tone() {
		let mut estimate = Noise::new(1);
		let pcm = tone(48_000, 1.0, 997.0, 0.01, 1);

		for chunk in pcm.chunks(WINDOW) {
			estimate.update(&block(chunk));
		}

		assert!(!estimate.initialised(), "a sine is not background noise");
		assert_eq!(estimate.energy(0), UNINITIALISED);
	}

	#[test]
	fn generates_nothing_until_it_is_initialised() {
		let mut estimate = Noise::new(2);
		let mut out = vec![1.0; 960];
		estimate.generate(&mut out, 1.0, &mut Rng::new());
		assert!(out.iter().all(|s| *s == 0.0));
	}

	#[test]
	fn generates_noise_at_the_estimated_level() {
		let mut estimate = Noise::new(1);
		let level = 0.02;
		for chunk in noise(48_000, 1.0, level, 1).chunks(WINDOW) {
			estimate.update(chunk);
		}
		assert!(estimate.initialised());

		let mut out = vec![0.0; 4800];
		estimate.generate(&mut out, 1.0, &mut Rng::new());

		let energy = out.iter().map(|x| x * x).sum::<f32>() / out.len() as f32;
		let ratio = energy / estimate.energy(0);
		assert!(
			ratio > 0.25 && ratio < 4.0,
			"generated {energy} vs {}",
			estimate.energy(0)
		);
	}
}
