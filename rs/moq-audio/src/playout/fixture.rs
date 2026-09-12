//! Signals and measurements the playout tests share.
//!
//! Everything here is deterministic: the noise source is a fixed LCG, so a failure
//! reproduces exactly.

use std::f32::consts::TAU;

/// Interleaved samples of a sine, every channel in phase.
pub(crate) fn tone(rate: u32, seconds: f32, frequency: f32, amplitude: f32, channels: usize) -> Vec<f32> {
	let total = (rate as f32 * seconds) as usize;
	let step = TAU * frequency / rate as f32;
	(0..total)
		.flat_map(|i| {
			let sample = amplitude * (step * i as f32).sin();
			std::iter::repeat_n(sample, channels)
		})
		.collect()
}

/// Interleaved stereo where the right channel is the left one inverted.
pub(crate) fn antiphase(rate: u32, seconds: f32, frequency: f32, amplitude: f32) -> Vec<f32> {
	let mono = tone(rate, seconds, frequency, amplitude, 1);
	mono.into_iter().flat_map(|s| [s, -s]).collect()
}

/// Interleaved white noise in `-amplitude..amplitude`, the same in every channel.
pub(crate) fn noise(rate: u32, seconds: f32, amplitude: f32, channels: usize) -> Vec<f32> {
	let total = (rate as f32 * seconds) as usize;
	let mut state = 0x1234_5678_9abc_def0u64;
	(0..total)
		.flat_map(|_| {
			state = state
				.wrapping_mul(6364136223846793005)
				.wrapping_add(1442695040888963407);
			let uniform = ((state >> 40) as f32) / (1u64 << 23) as f32 - 1.0;
			std::iter::repeat_n(uniform * amplitude, channels)
		})
		.collect()
}

/// A signal with a short period plus enough noise to spoil its correlation.
pub(crate) fn buzz(rate: u32, seconds: f32, period: std::time::Duration, amplitude: f32, jitter: f32) -> Vec<f32> {
	let total = (rate as f32 * seconds) as usize;
	let len = super::frames(rate, period);
	let shape = noise(rate, period.as_secs_f32(), amplitude, 1);
	let dither = noise(rate, seconds, jitter, 1);
	(0..total).map(|i| shape[i % len] + dither[i]).collect()
}

/// Mean per sample energy.
pub(crate) fn energy(pcm: &[f32]) -> f32 {
	pcm.iter().map(|x| x * x).sum::<f32>() / pcm.len().max(1) as f32
}

/// Goertzel magnitude of `frequency` in `pcm`, normalised by length.
pub(crate) fn goertzel(pcm: &[f32], rate: u32, frequency: f32) -> f32 {
	let coefficient = 2.0 * (TAU * frequency / rate as f32).cos();
	let (mut first, mut second) = (0.0f32, 0.0f32);
	for sample in pcm {
		let next = sample + coefficient * first - second;
		second = first;
		first = next;
	}
	let power = first * first + second * second - coefficient * first * second;
	power.max(0.0).sqrt() / pcm.len() as f32
}

/// The strongest frequency in `low..high`, to 0.5 Hz.
pub(crate) fn dominant(pcm: &[f32], rate: u32, low: f32, high: f32) -> f32 {
	let mut best = (low, f32::MIN);
	let mut frequency = low;
	while frequency <= high {
		let magnitude = goertzel(pcm, rate, frequency);
		if magnitude > best.1 {
			best = (frequency, magnitude);
		}
		frequency += 0.5;
	}
	best.0
}

/// The largest jump between consecutive samples.
pub(crate) fn max_step(pcm: &[f32]) -> f32 {
	pcm.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max)
}

/// The longest run of samples that are exactly zero.
pub(crate) fn zero_run(pcm: &[f32]) -> usize {
	let mut longest = 0;
	let mut run = 0;
	for sample in pcm {
		run = if *sample == 0.0 { run + 1 } else { 0 };
		longest = longest.max(run);
	}
	longest
}
