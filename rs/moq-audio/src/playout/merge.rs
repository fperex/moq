//! Getting back to real audio after a concealment.
//!
//! Mirrors `merge.cc`. Concealment and the packet that finally arrives are the same
//! speech at different phases, so splicing them at an arbitrary point is a click.
//! This finds where the returning audio lines up with the concealment, keeps the
//! concealment up to that point, and crossfades across the join. A packet that comes
//! back much louder than the concealment faded to is brought in quietly and let back
//! up over the crossfade, which is the other half of what makes the return inaudible.

use std::time::Duration;

use super::{BLOCK, DECIMATED, MAX_LAG, decimate, fade, frames};

/// The crossfade across the join, NetEq's `kMaxCorrelationLength * fs_mult`.
const FADE: Duration = Duration::from_micros(7_500);

/// How much audio the energies are compared over, NetEq's `64 * fs_mult`.
const SCALING: Duration = Duration::from_millis(8);

/// The splice from concealment back to real audio, for one stream.
pub(crate) struct Merge {
	rate: u32,
	channels: usize,
	/// Crossfade length, in frames.
	fade: usize,
	/// How much of each side the energies are compared over, in frames.
	scaling: usize,
	/// How far ahead the alignment search looks, in 4 kHz samples.
	search: usize,
	/// How much returning audio the search matches on, in 4 kHz samples.
	window: usize,
}

impl Merge {
	/// A splice for interleaved `channels` channel PCM at `rate`.
	pub(crate) fn new(rate: u32, channels: usize) -> Self {
		Self {
			rate,
			channels: channels.max(1),
			fade: frames(rate, FADE),
			scaling: frames(rate, SCALING),
			search: frames(DECIMATED, MAX_LAG),
			window: frames(DECIMATED, BLOCK),
		}
	}

	/// Splice `input` onto `expanded`, appending the result to `out`.
	///
	/// Returns the frames of `expanded` kept ahead of the crossfade, so the caller
	/// knows how much concealment the returning audio paid for. The result is that
	/// many frames longer than `input`.
	pub(crate) fn merge(&self, expanded: &[f32], input: &[f32], out: &mut Vec<f32>) -> usize {
		let concealed = expanded.len() / self.channels;
		let returning = input.len() / self.channels;
		if concealed == 0 || returning == 0 {
			out.extend_from_slice(input);
			return 0;
		}

		let best = self.align(expanded, input).min(concealed.saturating_sub(1));
		let overlap = self.fade.min(concealed - best).min(returning);
		let gain = self.scale(expanded, input);

		out.extend_from_slice(&expanded[..best * self.channels]);

		for frame in 0..overlap {
			let weight = fade(frame, overlap);
			// Back to full scale across the crossfade, so the packet is never held
			// down once the concealment underneath it is gone.
			let unmute = gain + (1.0 - gain) * (frame as f32 / overlap as f32);
			for index in 0..self.channels {
				let old = expanded[(best + frame) * self.channels + index];
				let new = input[frame * self.channels + index];
				out.push(old * weight + new * unmute * (1.0 - weight));
			}
		}

		out.extend_from_slice(&input[overlap * self.channels..]);
		best
	}

	/// Where the returning audio sits against the concealment, in frames.
	///
	/// A plain cross correlation on the 4 kHz decimation, as NetEq does: the
	/// crossfade that follows is wide enough to absorb what the decimation misses.
	fn align(&self, expanded: &[f32], input: &[f32]) -> usize {
		let ratio = f64::from(self.rate) / f64::from(DECIMATED);
		let concealed = expanded.len() / self.channels;
		let returning = input.len() / self.channels;

		let width = self.window.min((returning as f64 / ratio) as usize);
		let span = (self.search + width).min((concealed as f64 / ratio) as usize);
		if width == 0 || span <= width {
			return 0;
		}

		let mut new = vec![0.0; width];
		let mut old = vec![0.0; span];
		decimate(
			&super::channel(input, self.channels, 0)[..(width as f64 * ratio) as usize],
			&mut new,
		);
		decimate(
			&super::channel(expanded, self.channels, 0)[..(span as f64 * ratio) as usize],
			&mut old,
		);

		let best = (0..=span - width)
			.map(|lag| (0..width).map(|i| new[i] * old[lag + i]).sum::<f32>())
			.enumerate()
			.fold((0usize, f32::MIN), |best, (lag, score)| match score > best.1 {
				true => (lag, score),
				false => best,
			})
			.0;

		(best as f64 * ratio) as usize
	}

	/// How far the returning audio is turned down to meet the concealment.
	///
	/// Only ever down: concealment that faded toward the background must not be
	/// jumped back up to a full scale packet in one sample.
	fn scale(&self, expanded: &[f32], input: &[f32]) -> f32 {
		let count = self
			.scaling
			.min(expanded.len() / self.channels)
			.min(input.len() / self.channels);

		let energy = |pcm: &[f32]| -> f32 {
			pcm[..count * self.channels]
				.iter()
				.step_by(self.channels)
				.map(|x| x * x)
				.sum::<f32>()
		};

		let old = energy(expanded);
		let new = energy(input);
		match new > old && new > 0.0 {
			true => (old / new).sqrt(),
			false => 1.0,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::super::fixture::{energy, max_step, tone};
	use super::*;

	#[test]
	fn splices_a_tone_back_onto_itself_without_a_click() {
		let rate = 48_000;
		let source = tone(rate, 0.2, 997.0, 0.5, 1);
		// Concealment that has drifted a quarter period out of phase.
		let expanded = &source[12..12 + frames(rate, Duration::from_millis(30))];
		let returning = &source[..frames(rate, BLOCK)];

		let merge = Merge::new(rate, 1);
		let mut out = Vec::new();
		let kept = merge.merge(expanded, returning, &mut out);

		assert_eq!(out.len(), kept + returning.len());
		let slope = 0.5 * std::f32::consts::TAU * 997.0 / rate as f32;
		assert!(max_step(&out) < 1.5 * slope, "seam step {}", max_step(&out));
	}

	#[test]
	fn brings_a_loud_return_in_quietly() {
		let rate = 48_000;
		let expanded = tone(rate, 0.03, 997.0, 0.01, 1);
		let returning = tone(rate, 0.01, 997.0, 0.5, 1);

		let merge = Merge::new(rate, 1);
		let mut out = Vec::new();
		let kept = merge.merge(&expanded, &returning, &mut out);

		let head = &out[kept..kept + frames(rate, Duration::from_millis(1))];
		assert!(
			energy(head) < energy(&returning[..head.len()]) / 4.0,
			"the return was not scaled down: {} vs {}",
			energy(head),
			energy(&returning[..head.len()])
		);
		// And it is back at full scale by the end.
		let tail = &out[out.len() - frames(rate, Duration::from_millis(1))..];
		assert!(energy(tail) > energy(&returning) / 2.0, "the return never came back up");
	}

	#[test]
	fn an_empty_side_is_a_passthrough() {
		let merge = Merge::new(48_000, 1);
		let mut out = Vec::new();
		assert_eq!(merge.merge(&[], &[1.0, 2.0], &mut out), 0);
		assert_eq!(out, vec![1.0, 2.0]);
	}
}
