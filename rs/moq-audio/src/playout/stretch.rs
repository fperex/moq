//! Making a block of audio shorter or longer without changing its pitch.
//!
//! Mirrors `time_stretch.cc` and its two subclasses, `accelerate.cc` and
//! `preemptive_expand.cc`. Both operations are the same splice: find the pitch
//! period, then either drop one period by crossfading over it (the buffer is too
//! full, so play the same audio in less time) or repeat one period the same way (the
//! buffer is too empty, so take longer over it). One period is the only length that
//! leaves the waveform continuous, which is why the whole thing hangs off a
//! correlation search.
//!
//! The search runs twice. A coarse pass over a 4 kHz decimation picks the lag out of
//! 50 candidates between 2.5 and 15 ms, and one normalised correlation at full rate
//! then says whether that lag is good enough to splice on. A block that is barely
//! above the room tone skips the second test entirely: nobody can hear a splice in
//! noise, and the correlation of noise is meaningless.

use std::time::Duration;

use super::noise::Noise;
use super::{
	CORRELATION, CORRELATION_FAST, DECIMATED, MAX_LAG, MIN_LAG, OVERLAP, PASSIVE_GATE, SEARCH, channel, decimate, fade,
	frames,
};

/// How well a sub-multiple of the winning lag must correlate before it is preferred
/// to the lag itself.
const SUBMULTIPLE: f32 = 0.9;

/// What one time stretch attempt did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stretched {
	/// The block was spliced, changing its length by `frames` frames.
	Applied {
		/// Frames removed by an accelerate, or inserted by a preemptive expand.
		frames: usize,
		/// Whether the block was loud enough to count as speech.
		active: bool,
	},
	/// Nothing was written: the correlation was too weak to splice on, so the caller
	/// should play the block as it stands.
	Skipped,
}

/// What the pitch search found.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Match {
	/// The pitch period, in frames.
	pub(crate) lag: usize,
	/// Normalised correlation at that lag, in `0.0..=1.0`.
	pub(crate) correlation: f32,
	/// Whether the block sits far enough above the background to count as speech.
	pub(crate) active: bool,
}

/// The accelerate and preemptive expand pair for one stream.
pub(crate) struct Stretch {
	rate: u32,
	channels: usize,
	max_lag: usize,
	window: usize,
	overlap: usize,
}

impl Stretch {
	/// A stretcher for interleaved `channels` channel PCM at `rate`.
	pub(crate) fn new(rate: u32, channels: usize) -> Self {
		Self {
			rate,
			channels: channels.max(1),
			max_lag: frames(rate, MAX_LAG),
			window: frames(rate, SEARCH),
			overlap: frames(rate, OVERLAP),
		}
	}

	/// Frames per channel either operation needs before it will look at a block: two
	/// 15 ms halves less one frame, as NetEq's `(2 * k15ms - 1) * fs_mult`, which is
	/// what lets a rate whose 15 ms does not land on a whole frame still stretch a
	/// 30 ms block.
	pub(crate) fn required(&self) -> usize {
		2 * self.max_lag - 1
	}

	/// The pitch period of `input` and how much the waveform repeats at it.
	///
	/// Reads the reference channel only, as NetEq does, and applies the result to
	/// every channel: a splice at different points per channel would smear the
	/// stereo image.
	pub(crate) fn analyse(&self, input: &[f32], noise: &Noise) -> Match {
		let reference = channel(input, self.channels, 0);
		let lag = peak(&reference[..self.max_lag + self.window], self.rate, SEARCH).min(reference.len() - self.max_lag);

		// The two halves either side of the 15 ms mark, one pitch period each.
		let old = &reference[self.max_lag - lag..self.max_lag];
		let new = &reference[self.max_lag..self.max_lag + lag];

		let old_energy: f32 = old.iter().map(|x| x * x).sum();
		let new_energy: f32 = new.iter().map(|x| x * x).sum();
		let cross: f32 = old.iter().zip(new).map(|(a, b)| a * b).sum();

		// NetEq's one line VAD: below eight times the background, a splice is
		// inaudible whatever the correlation says.
		let mean = (old_energy + new_energy) / (2 * lag) as f32;
		let active = mean > PASSIVE_GATE * noise.energy(0);

		let correlation = match old_energy > 0.0 && new_energy > 0.0 {
			true => (cross / (old_energy * new_energy).sqrt()).clamp(0.0, 1.0),
			false => 0.0,
		};

		Match {
			lag,
			correlation,
			active,
		}
	}

	/// Drop one pitch period from `input`, appending `input` minus that period to
	/// `out`.
	///
	/// `fast` is NetEq's fast accelerate: it settles for half the correlation and
	/// folds the period up to as many whole copies as fit in 15 ms, for a buffer so
	/// far above target that one period at a time will never catch up.
	pub(crate) fn accelerate(&self, input: &[f32], noise: &Noise, fast: bool, out: &mut Vec<f32>) -> Stretched {
		let total = input.len() / self.channels;
		if total < self.required() {
			return Stretched::Skipped;
		}

		let found = self.analyse(input, noise);
		let threshold = match fast {
			true => CORRELATION_FAST,
			false => CORRELATION,
		};
		if found.active && found.correlation <= threshold {
			return Stretched::Skipped;
		}

		let mut lag = found.lag;
		if fast {
			// As many whole periods as fit in 15 ms, and as fit in the block.
			let copies = (self.max_lag / lag).min((total - self.max_lag) / lag);
			lag *= copies;
		}

		// Keep the first 15 ms, crossfade the period that follows onto its tail, then
		// keep everything past that period. The output is one period shorter.
		out.extend_from_slice(&input[..self.max_lag * self.channels]);
		self.crossfade(out, &input[self.max_lag * self.channels..], lag);
		out.extend_from_slice(&input[(self.max_lag + lag) * self.channels..]);

		Stretched::Applied {
			frames: lag,
			active: found.active,
		}
	}

	/// Repeat one pitch period of `input`, appending `input` plus that period to
	/// `out`.
	///
	/// `old` is how many leading frames the caller has already played, which must
	/// stay untouched. NetEq has no fast mode here: a buffer that is too empty cannot
	/// afford a worse splice.
	pub(crate) fn preemptive_expand(&self, input: &[f32], old: usize, noise: &Noise, out: &mut Vec<f32>) -> Stretched {
		let total = input.len() / self.channels;
		if total < self.required() || old + self.overlap >= total {
			return Stretched::Skipped;
		}

		let found = self.analyse(input, noise);
		if found.active && (found.correlation <= CORRELATION || old > self.max_lag) {
			return Stretched::Skipped;
		}

		// The splice sits at 15 ms, or at the end of the played part if that is later.
		let unmodified = old.max(self.max_lag);
		let lag = found.lag.min(total - unmodified);

		out.extend_from_slice(&input[..(unmodified + lag) * self.channels]);
		self.crossfade(out, &input[(unmodified - lag) * self.channels..], lag);
		out.extend_from_slice(&input[unmodified * self.channels..]);

		Stretched::Applied {
			frames: lag,
			active: found.active,
		}
	}

	/// Fade the last `lag` frames of `out` into the first `lag` frames of `into`.
	fn crossfade(&self, out: &mut [f32], into: &[f32], lag: usize) {
		let start = out.len() - lag * self.channels;
		for frame in 0..lag {
			let weight = fade(frame, lag);
			for index in 0..self.channels {
				let at = start + frame * self.channels + index;
				out[at] = out[at] * weight + into[frame * self.channels + index] * (1.0 - weight);
			}
		}
	}
}

/// The lag, in frames, whose autocorrelation against the last `window` of `signal`
/// is strongest.
///
/// One channel, and `signal` must hold `window` plus 15 ms. Mirrors
/// `TimeStretch::AutoCorrelation` plus `DspHelper::PeakDetection`: the search itself
/// runs on a 4 kHz decimation, and a parabola through the winning bin and its
/// neighbours recovers most of what the decimation threw away.
pub(crate) fn peak(signal: &[f32], rate: u32, window: Duration) -> usize {
	let min_lag = frames(rate, MIN_LAG);
	let max_lag = frames(rate, MAX_LAG);
	let span = frames(rate, window) + max_lag;
	debug_assert!(signal.len() >= span);

	let mut decimated = vec![0.0; frames(DECIMATED, window + MAX_LAG)];
	decimate(&signal[signal.len() - span..], &mut decimated);

	let width = frames(DECIMATED, window);
	let min = frames(DECIMATED, MIN_LAG);
	// Where the correlation window starts, which is also the furthest back a lag can
	// reach without running off the front of the decimation.
	let head = decimated.len() - width;
	let longest = frames(DECIMATED, MAX_LAG).min(head);

	let correlation: Vec<f32> = (min..longest)
		.map(|lag| {
			(0..width)
				.map(|i| decimated[head + i] * decimated[head - lag + i])
				.sum()
		})
		.collect();

	let mut best = correlation
		.iter()
		.enumerate()
		.max_by(|a, b| a.1.total_cmp(b.1))
		.map(|(index, _)| index)
		.unwrap_or(0);

	// A periodic signal correlates about as well at twice its period as at its
	// period, and NetEq splices on whichever wins because either is a whole number of
	// cycles. We want the fundamental: concealment repeats this lag verbatim, and
	// fast accelerate folds it back up to 15 ms, so starting from a multiple costs
	// both of them. Walk down the sub-multiples and take the shortest one that still
	// correlates nearly as well.
	let strongest = min + best;
	if correlation[best] > 0.0 {
		let floor = SUBMULTIPLE * correlation[best];
		for divisor in 2..=(strongest / min).max(1) {
			let candidate = strongest / divisor;
			if correlation[candidate - min] >= floor {
				best = candidate - min;
			}
		}
	}

	// Parabolic fit through the peak and its neighbours, for the sub-sample part of
	// the lag that the decimation cannot see.
	let mut refined = (min + best) as f64;
	if best > 0 && best + 1 < correlation.len() {
		let (left, centre, right) = (
			f64::from(correlation[best - 1]),
			f64::from(correlation[best]),
			f64::from(correlation[best + 1]),
		);
		let denominator = left - 2.0 * centre + right;
		if denominator < 0.0 {
			refined += (0.5 * (left - right) / denominator).clamp(-1.0, 1.0);
		}
	}

	((refined * f64::from(rate) / f64::from(DECIMATED)).round() as usize).clamp(min_lag, max_lag)
}

#[cfg(test)]
mod tests {
	use super::super::fixture::{antiphase, buzz, dominant, energy, max_step, noise, tone, zero_run};
	use super::super::{MAX_LAG, channel};
	use super::*;

	/// A tone's steepest slope per sample, which a clean splice never exceeds.
	fn slope(rate: u32, frequency: f32, amplitude: f32) -> f32 {
		amplitude * std::f32::consts::TAU * frequency / rate as f32
	}

	#[test]
	fn finds_the_pitch_period_of_a_tone() {
		for rate in [48_000, 44_100] {
			let pcm = tone(rate, 0.1, 200.0, 0.5, 1);
			let found = peak(&pcm[..frames(rate, SEARCH + MAX_LAG)], rate, SEARCH);
			let period = rate as f64 / 200.0;
			let tolerance = f64::from(rate) / f64::from(DECIMATED);
			assert!(
				(found as f64 - period).abs() <= tolerance,
				"{rate} Hz: found {found}, period {period}, tolerance {tolerance}"
			);
		}
	}

	#[test]
	fn accelerate_keeps_the_tone_and_drops_one_period() {
		for rate in [48_000, 44_100] {
			let pcm = tone(rate, 0.05, 997.0, 0.5, 1);
			let input = &pcm[..frames(rate, Duration::from_millis(30))];
			let stretch = Stretch::new(rate, 1);
			let quiet = Noise::new(1);

			let mut out = Vec::new();
			let result = stretch.accelerate(input, &quiet, false, &mut out);

			let Stretched::Applied {
				frames: removed,
				active,
			} = result
			else {
				panic!("a loud clean tone should accelerate at {rate}: {result:?}");
			};
			assert!(active, "a 0.5 amplitude tone is not passive");
			assert_eq!(out.len(), input.len() - removed);

			let found = dominant(&out, rate, 900.0, 1100.0);
			assert!((found - 997.0).abs() < 9.97, "{rate}: dominant {found} Hz");
			assert!(zero_run(&out) <= 2, "{rate}: {} exact zeros in a row", zero_run(&out));
			assert!(
				max_step(&out) < 1.5 * slope(rate, 997.0, 0.5),
				"{rate}: step {}",
				max_step(&out)
			);
		}
	}

	#[test]
	fn preemptive_expand_keeps_the_tone_and_adds_one_period() {
		for rate in [48_000, 44_100] {
			let pcm = tone(rate, 0.05, 997.0, 0.5, 1);
			let input = &pcm[..frames(rate, Duration::from_millis(30))];
			let stretch = Stretch::new(rate, 1);
			let quiet = Noise::new(1);

			let mut out = Vec::new();
			let result = stretch.preemptive_expand(input, 0, &quiet, &mut out);

			let Stretched::Applied { frames: added, .. } = result else {
				panic!("a loud clean tone should expand at {rate}: {result:?}");
			};
			assert_eq!(out.len(), input.len() + added);

			let found = dominant(&out, rate, 900.0, 1100.0);
			assert!((found - 997.0).abs() < 9.97, "{rate}: dominant {found} Hz");
			assert!(zero_run(&out) <= 2, "{rate}: {} exact zeros in a row", zero_run(&out));
			assert!(
				max_step(&out) < 1.5 * slope(rate, 997.0, 0.5),
				"{rate}: step {}",
				max_step(&out)
			);
		}
	}

	#[test]
	fn passive_noise_stretches_without_a_correlation() {
		let rate = 48_000;
		// -60 dBFS, three orders of magnitude under the background floor, so the gate
		// calls it passive however uncorrelated it is.
		let input = noise(rate, 0.03, 0.001, 1);
		let stretch = Stretch::new(rate, 1);
		let quiet = Noise::new(1);

		let found = stretch.analyse(&input, &quiet);
		assert!(!found.active, "-60 dBFS noise is not speech");
		assert!(found.correlation < 0.5, "noise correlated at {}", found.correlation);

		let mut out = Vec::new();
		let result = stretch.accelerate(&input, &quiet, false, &mut out);
		assert!(matches!(result, Stretched::Applied { active: false, .. }), "{result:?}");
	}

	#[test]
	fn loud_aperiodic_audio_is_left_alone() {
		let rate = 48_000;
		let input = noise(rate, 0.03, 0.5, 1);
		let stretch = Stretch::new(rate, 1);
		let quiet = Noise::new(1);

		let found = stretch.analyse(&input, &quiet);
		assert!(found.active, "0.5 amplitude noise is well above the floor");
		assert!(found.correlation < CORRELATION, "correlated at {}", found.correlation);

		let mut out = vec![42.0];
		assert_eq!(stretch.accelerate(&input, &quiet, false, &mut out), Stretched::Skipped);
		assert_eq!(
			stretch.preemptive_expand(&input, 0, &quiet, &mut out),
			Stretched::Skipped
		);
		assert_eq!(out, vec![42.0], "a skipped block must not touch the output");
	}

	#[test]
	fn fast_mode_accepts_half_the_correlation_and_folds_the_period() {
		let rate = 48_000;
		let period = Duration::from_millis(3);
		let input = buzz(rate, 0.03, period, 0.4, 0.28);
		let stretch = Stretch::new(rate, 1);
		let quiet = Noise::new(1);

		let found = stretch.analyse(&input, &quiet);
		assert!(found.active);
		assert!(
			found.correlation > CORRELATION_FAST && found.correlation <= CORRELATION,
			"correlation {} is not between the two thresholds",
			found.correlation
		);

		let mut skipped = Vec::new();
		assert_eq!(
			stretch.accelerate(&input, &quiet, false, &mut skipped),
			Stretched::Skipped
		);

		let mut out = Vec::new();
		let result = stretch.accelerate(&input, &quiet, true, &mut out);
		let Stretched::Applied { frames: removed, .. } = result else {
			panic!("fast mode should accept this: {result:?}");
		};

		let folded = (frames(rate, MAX_LAG) / found.lag) * found.lag;
		assert_eq!(removed, folded);
		assert!(removed >= 2 * found.lag, "{removed} is not a folded {} ", found.lag);
		assert_eq!(out.len(), input.len() - removed);
	}

	#[test]
	fn stereo_stays_antiphase_through_both_operations() {
		let rate = 48_000;
		let pcm = antiphase(rate, 0.05, 997.0, 0.5);
		let input = &pcm[..frames(rate, Duration::from_millis(30)) * 2];
		let stretch = Stretch::new(rate, 2);
		let quiet = Noise::new(2);

		for out in [
			{
				let mut out = Vec::new();
				stretch.accelerate(input, &quiet, false, &mut out);
				out
			},
			{
				let mut out = Vec::new();
				stretch.preemptive_expand(input, 0, &quiet, &mut out);
				out
			},
		] {
			assert!(!out.is_empty());
			let left = channel(&out, 2, 0);
			let right = channel(&out, 2, 1);
			let sum: Vec<f32> = left.iter().zip(&right).map(|(l, r)| l + r).collect();
			assert!(energy(&sum) < 1e-12, "channels drifted apart: {}", energy(&sum));
		}
	}
}
