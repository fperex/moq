//! What to play when the next packet is not there yet.
//!
//! Mirrors `expand.cc`. The last 30 ms of real audio are taken apart into a pitch
//! period and a noise spectrum, and each call makes one more block out of the two:
//! the period repeated for the voiced part, white noise through a sixth order filter
//! for the unvoiced part, and a mix between them set by how periodic the signal
//! actually was. A held vowel is nearly all period; a fricative is nearly all noise.
//!
//! Every block after the first is quieter than the last, and once the muting slope
//! has taken the gain to zero the output is digital silence, so an outage that never
//! ends is not a sound. That is what the pinned Chromium tree does: `Expand::Process`
//! scales each block by `mute_factor`, drops the factor by the muting slope every
//! block, and pins it to zero outright past the third consecutive expansion once the
//! slope would no longer lower it; `BackgroundNoise::GenerateBackgroundNoise` ignores
//! both the slope and `TooManyExpands()` it is handed and never raises its own mute
//! factor, which `ChannelParameters::Reset` leaves at 0, so the noise term contributes
//! nothing at any point. Comfort noise belongs to a codec that says it is sending
//! comfort noise; if hang ever carries a DTX/CNG signal, that is where it goes, not
//! here.
//!
//! One simplification against the original, audible only on a long outage, which the
//! muting slope covers anyway: NetEq keeps three candidate lags and alternates between
//! them so a long concealment does not sound metronomic. We keep one.

use std::time::Duration;

use super::stretch::peak;
use super::{BLOCK, MAX_CONSECUTIVE_EXPANDS, MAX_LAG, OVERLAP, Rng, channel, fade, frames};

/// Order of the filter that shapes the unvoiced part, NetEq's `kUnvoicedLpcOrder`.
const ORDER: usize = 6;

/// Real audio [`Expand::analyse`] studies, NetEq's `256 * fs_mult`.
const HISTORY: Duration = Duration::from_millis(32);

/// Audio the unvoiced filter is fitted over, NetEq's `kLpcAnalysisLength`.
const ANALYSIS: Duration = Duration::from_millis(20);

/// Correlation under which a signal counts as unvoiced and the period is not worth
/// repeating on its own.
const VOICED: f32 = 0.48;

/// Muting slopes from `expand.cc`, in gain lost per second: the floor for a signal
/// that was not very periodic, then the two escalations a concealment which has gone
/// on too long is forced to. Divided by the sample rate to get the per frame step.
const MUTE_FLOOR: f32 = 40.0;
const MUTE_AFTER_3: f32 = 8.0;
const MUTE_AFTER_7: f32 = 16.0;

/// Voice mix under which the muting floor applies, NetEq's `13107` in Q14.
const MUTE_FLOOR_MIX: f32 = 0.8;

/// Concealment for one stream.
pub(crate) struct Expand {
	rate: u32,
	channels: Vec<Channel>,
	block: usize,
	overlap: usize,
	/// The pitch period being repeated, in frames.
	lag: usize,
	/// How far into that period the next block starts.
	position: usize,
	consecutive: u32,
	ready: bool,
	rng: Rng,
	excitation: Vec<f32>,
}

/// One channel's concealment: a period to repeat, a filter to drive, and the two
/// gains that fade one into the other and then the whole thing out.
struct Channel {
	period: Vec<f32>,
	filter: [f32; ORDER],
	state: [f32; ORDER],
	gain: f32,
	voice_mix: f32,
	current_mix: f32,
	mix_step: f32,
	mute: f32,
	mute_slope: f32,
}

impl Expand {
	/// Concealment for interleaved `channels` channel PCM at `rate`.
	pub(crate) fn new(rate: u32, channels: usize) -> Self {
		Self {
			rate,
			channels: (0..channels.max(1)).map(|_| Channel::new()).collect(),
			block: frames(rate, BLOCK),
			overlap: frames(rate, OVERLAP),
			lag: 0,
			position: 0,
			consecutive: 0,
			ready: false,
			rng: Rng::new(),
			excitation: Vec::new(),
		}
	}

	/// Frames per channel [`Self::analyse`] needs.
	pub(crate) fn history(&self) -> usize {
		frames(self.rate, HISTORY)
	}

	/// How many blocks have been concealed since the last real audio.
	pub(crate) fn consecutive(&self) -> u32 {
		self.consecutive
	}

	/// Whether the ceiling is reached and the output is silence from here.
	pub(crate) fn exhausted(&self) -> bool {
		self.consecutive >= MAX_CONSECUTIVE_EXPANDS
	}

	/// Study the tail of the real signal. Call once, when concealment starts.
	pub(crate) fn analyse(&mut self, history: &[f32]) {
		let count = self.channels.len();
		let total = history.len() / count;
		debug_assert!(total >= self.history());

		let reference = channel(history, count, 0);
		self.lag = peak(&reference, self.rate, MAX_LAG);
		self.position = 0;
		self.consecutive = 0;
		self.ready = true;

		let blend = self.overlap.min(self.lag / 2);
		let correlation = correlation(&reference, self.lag, frames(self.rate, MAX_LAG));
		let voice_mix = match correlation > VOICED {
			true => voice_mix(correlation),
			false => 0.0,
		};

		for (index, state) in self.channels.iter_mut().enumerate() {
			let samples = match index {
				0 => reference.clone(),
				_ => channel(history, count, index),
			};
			state.analyse(&samples, self.lag, blend, voice_mix, self.rate);
		}
	}

	/// Append one block of concealment to `out`.
	pub(crate) fn process(&mut self, out: &mut Vec<f32>) {
		let count = self.channels.len();
		let start = out.len();
		out.resize(start + self.block * count, 0.0);

		if !self.ready || self.exhausted() {
			// Nothing to repeat, or nothing left worth repeating. Silence, not room tone: an
			// outage this long is not a quiet room, and a listener who can hear the noise cannot
			// tell whether the talker went quiet or the stream died.
			self.consecutive = (self.consecutive + 1).min(MAX_CONSECUTIVE_EXPANDS);
			return;
		}

		// One excitation for every channel, so a correlated image stays correlated.
		self.excitation.clear();
		self.excitation.extend((0..self.block).map(|_| self.rng.sample()));

		for (index, state) in self.channels.iter_mut().enumerate() {
			state.escalate(self.consecutive, self.rate);
			let mut position = self.position;

			for frame in 0..self.block {
				let voiced = state.period[position];
				let unvoiced = state.unvoiced(self.excitation[frame]);
				let mixed = voiced * state.current_mix + unvoiced * (1.0 - state.current_mix);

				// The muting slope is the whole ramp: it reaches zero within ~100 ms of the
				// escalations, and there is nothing underneath it to fade into.
				let at = start + frame * count + index;
				out[at] = mixed * state.mute;

				position = (position + 1) % state.period.len();
				state.advance();
			}
		}

		self.position = (self.position + self.block) % self.lag;
		self.consecutive = (self.consecutive + 1).min(MAX_CONSECUTIVE_EXPANDS);
	}

	/// Forget the analysis, so the next concealment studies fresh audio.
	pub(crate) fn reset(&mut self) {
		self.ready = false;
		self.consecutive = 0;
		self.position = 0;
		for state in &mut self.channels {
			*state = Channel::new();
		}
	}
}

impl Channel {
	fn new() -> Self {
		Self {
			period: vec![0.0],
			filter: [0.0; ORDER],
			state: [0.0; ORDER],
			gain: 0.0,
			voice_mix: 0.0,
			current_mix: 1.0,
			mix_step: 0.0,
			mute: 1.0,
			mute_slope: 0.0,
		}
	}

	fn analyse(&mut self, samples: &[f32], lag: usize, blend: usize, voice_mix: f32, rate: u32) {
		// One period, with its own tail faded into the run that preceded it, so
		// repeating it joins up where it wraps.
		let tail = &samples[samples.len() - lag - blend..];
		let mut period = tail[blend..].to_vec();
		for i in 0..blend {
			let weight = fade(i, blend);
			period[lag - blend + i] = period[lag - blend + i] * weight + tail[i] * (1.0 - weight);
		}
		self.period = period;

		let analysis = frames(rate, ANALYSIS).min(samples.len());
		let window = &samples[samples.len() - analysis..];
		match fit(window) {
			Some((filter, residual)) => {
				self.filter = filter;
				self.gain = residual.sqrt();
			}
			None => {
				self.filter = [0.0; ORDER];
				self.gain = 0.0;
			}
		}
		for (i, slot) in self.state.iter_mut().enumerate() {
			*slot = samples[samples.len() - 1 - i];
		}

		self.voice_mix = voice_mix;
		self.current_mix = 1.0;
		self.mute = 1.0;

		// The mix walks from all period to its final blend over 8, 16, or 32 ms,
		// longer for a longer period, as `expand.cc` picks by `max_lag_`.
		let mult = f64::from(rate) / 8000.0;
		let ramp = if lag as f64 <= 31.0 * mult {
			8
		} else if lag as f64 <= 63.0 * mult {
			16
		} else {
			32
		};
		self.mix_step = (1.0 - voice_mix) / frames(rate, Duration::from_millis(ramp)) as f32;

		// With a single expansion vector the amplitude ratio NetEq derives its slope
		// from is 1.0 by construction, which leaves only these two cases: hold a
		// periodic signal steady, and fade a barely periodic one out at the floor.
		self.mute_slope = match voice_mix <= MUTE_FLOOR_MIX {
			true => MUTE_FLOOR / rate as f32,
			false => 0.0,
		};
	}

	/// A concealment that has gone on too long is muted whatever it sounded like.
	fn escalate(&mut self, consecutive: u32, rate: u32) {
		if consecutive == 3 {
			self.mute_slope = self.mute_slope.max(MUTE_AFTER_3 / rate as f32);
		}
		if consecutive == 7 {
			self.mute_slope = self.mute_slope.max(MUTE_AFTER_7 / rate as f32);
		}
	}

	/// One sample of noise through the fitted filter.
	fn unvoiced(&mut self, excitation: f32) -> f32 {
		let predicted: f32 = self.filter.iter().zip(&self.state).map(|(a, y)| a * y).sum();
		let sample = (self.gain * excitation + predicted).clamp(-1.0, 1.0);
		self.state.rotate_right(1);
		self.state[0] = sample;
		sample
	}

	fn advance(&mut self) {
		self.current_mix = (self.current_mix - self.mix_step).max(self.voice_mix);
		self.mute = (self.mute - self.mute_slope).max(0.0);
	}
}

/// Normalised correlation of the last `window` frames of `samples` against the run
/// one `lag` earlier.
fn correlation(samples: &[f32], lag: usize, window: usize) -> f32 {
	let end = samples.len();
	let new = &samples[end - window..];
	let old = &samples[end - window - lag..end - lag];

	let new_energy: f32 = new.iter().map(|x| x * x).sum();
	let old_energy: f32 = old.iter().map(|x| x * x).sum();
	if new_energy <= 0.0 || old_energy <= 0.0 {
		return 0.0;
	}

	let cross: f32 = new.iter().zip(old).map(|(a, b)| a * b).sum();
	(cross / (new_energy * old_energy).sqrt()).clamp(0.0, 1.0)
}

/// How much of the concealment is the repeated period rather than noise.
///
/// The cubic from `expand.cc`, evaluated in float rather than Q14. It is deliberately
/// discontinuous at [`VOICED`]: below that the signal is treated as unvoiced outright.
fn voice_mix(correlation: f32) -> f32 {
	let x = f64::from(correlation);
	let mix = (-5179.0 + 19931.0 * x - 16422.0 * x * x + 5776.0 * x * x * x) / 4096.0;
	(mix as f32).clamp(0.0, 1.0)
}

/// Fit an order [`ORDER`] predictor to `window`, returning its coefficients and the
/// mean energy it leaves behind.
///
/// Levinson-Durbin, as `WebRtcSpl_LevinsonDurbin`. An unstable recursion is rejected
/// rather than clamped, which leaves the caller with a flat spectrum and no filter,
/// exactly as NetEq does.
fn fit(window: &[f32]) -> Option<([f32; ORDER], f32)> {
	if window.len() <= ORDER {
		return None;
	}

	let mut auto = [0.0f64; ORDER + 1];
	for (lag, slot) in auto.iter_mut().enumerate() {
		*slot = window[lag..]
			.iter()
			.zip(window)
			.map(|(a, b)| f64::from(*a) * f64::from(*b))
			.sum::<f64>()
			/ window.len() as f64;
	}
	if auto[0] <= 0.0 {
		return None;
	}

	let mut coefficients = [0.0f64; ORDER + 1];
	let mut error = auto[0];

	for i in 1..=ORDER {
		let mut acc = auto[i];
		for j in 1..i {
			acc -= coefficients[j] * auto[i - j];
		}
		let reflection = acc / error;
		if !reflection.is_finite() || reflection.abs() >= 1.0 {
			return None;
		}

		let previous = coefficients;
		coefficients[i] = reflection;
		for j in 1..i {
			coefficients[j] = previous[j] - reflection * previous[i - j];
		}

		error *= 1.0 - reflection * reflection;
		if error <= 0.0 {
			return None;
		}
	}

	let mut filter = [0.0f32; ORDER];
	for (i, slot) in filter.iter_mut().enumerate() {
		*slot = coefficients[i + 1] as f32;
	}
	Some((filter, error as f32))
}

#[cfg(test)]
mod tests {
	use super::super::fixture::{antiphase, dominant, energy, goertzel, noise as white, tone};
	use super::super::{channel as split, merge::Merge};
	use super::*;

	/// `count` blocks of concealment, concatenated.
	fn conceal(expand: &mut Expand, count: u32) -> Vec<f32> {
		let mut out = Vec::new();
		for _ in 0..count {
			expand.process(&mut out);
		}
		out
	}

	#[test]
	fn conceals_a_tone_and_fades_it_out() {
		let rate = 48_000;
		let history = tone(rate, 0.05, 997.0, 0.5, 1);
		let mut expand = Expand::new(rate, 1);
		expand.analyse(&history[history.len() - expand.history()..]);

		let mut blocks = Vec::new();
		for _ in 0..20 {
			let mut out = Vec::new();
			expand.process(&mut out);
			blocks.push(out);
		}

		let first = energy(&blocks[0]);
		let mut previous = f32::MAX;
		for (index, block) in blocks.iter().enumerate() {
			let level = energy(block);

			// Every block is quieter than the last, all the way down.
			assert!(level <= previous * 1.05, "block {index} grew: {level} after {previous}");
			previous = level;

			// And while it is still loud it is still the tone. Further down the unvoiced
			// part has taken over, which is what a fade is supposed to sound like.
			if level > first / 100.0 {
				let signal = goertzel(block, rate, 997.0);
				let off = goertzel(block, rate, 1600.0);
				assert!(signal > 8.0 * off, "block {index} lost its pitch: {signal} vs {off}");
			}
		}

		let all: Vec<f32> = blocks.concat();
		let found = dominant(&all, rate, 900.0, 1100.0);
		assert!((found - 997.0).abs() < 9.97, "dominant {found} Hz");

		// The muting slope reaches zero well inside the ceiling, so the tail is digital silence.
		let last = energy(blocks.last().unwrap());
		assert_eq!(last, 0.0, "twenty blocks did not reach silence: {last}");
	}

	#[test]
	fn plays_silence_from_the_ceiling_on() {
		let rate = 48_000;
		// Room tone under the signal, which is what the estimator used to hand back here: with
		// comfort noise this block came back at the room's own level and never stopped.
		let mut history = tone(rate, 0.05, 997.0, 0.5, 1);
		let room = white(rate, 0.05, 0.002, 1);
		for (sample, noise) in history.iter_mut().zip(&room) {
			*sample += noise;
		}

		let mut expand = Expand::new(rate, 1);
		expand.analyse(&history[history.len() - expand.history()..]);

		conceal(&mut expand, MAX_CONSECUTIVE_EXPANDS);
		assert!(expand.exhausted());
		assert_eq!(expand.consecutive(), MAX_CONSECUTIVE_EXPANDS);

		let after = conceal(&mut expand, 50);
		assert!(
			after.iter().all(|sample| *sample == 0.0),
			"the ceiling still made a sound"
		);
	}

	#[test]
	fn fades_a_long_outage_to_silence() {
		let rate = 48_000;
		let history = tone(rate, 0.05, 997.0, 0.5, 1);
		let mut expand = Expand::new(rate, 1);
		expand.analyse(&history[history.len() - expand.history()..]);

		let produced = conceal(&mut expand, MAX_CONSECUTIVE_EXPANDS);
		let tail = &produced[produced.len() - frames(rate, Duration::from_millis(1000))..];
		assert_eq!(energy(tail), 0.0);

		// And it got there smoothly: the last audible sample is small enough that stopping is
		// not a click.
		let last = produced.iter().rposition(|sample| *sample != 0.0).unwrap();
		assert!(produced[last].abs() < 0.01, "stopped at {}", produced[last]);
	}

	#[test]
	fn merges_back_into_real_audio_without_a_click() {
		let rate = 48_000;

		let source = tone(rate, 0.5, 997.0, 0.5, 1);
		let history = &source[..frames(rate, HISTORY)];
		let mut expand = Expand::new(rate, 1);
		expand.analyse(history);

		let concealed = conceal(&mut expand, 3);

		// The stream comes back where it would have been had nothing been lost.
		let resumed = &source[history.len() + concealed.len()..history.len() + concealed.len() + frames(rate, BLOCK)];

		let mut out = Vec::new();
		Merge::new(rate, 1).merge(&concealed, resumed, &mut out);

		let slope = 0.5 * std::f32::consts::TAU * 997.0 / rate as f32;
		let step = super::super::fixture::max_step(&out);
		assert!(step < 1.5 * slope, "seam step {step} against a slope of {slope}");
	}

	#[test]
	fn stereo_concealment_stays_antiphase() {
		let rate = 48_000;
		let history = antiphase(rate, 0.05, 997.0, 0.5);

		let mut expand = Expand::new(rate, 2);
		expand.analyse(&history[history.len() - expand.history() * 2..]);

		let out = conceal(&mut expand, 5);

		let left = split(&out, 2, 0);
		let right = split(&out, 2, 1);
		let sum: Vec<f32> = left.iter().zip(&right).map(|(l, r)| l + r).collect();
		assert!(
			energy(&sum) < 1e-9 * energy(&left),
			"channels drifted: {}",
			energy(&sum)
		);
	}
}
