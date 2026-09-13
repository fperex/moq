//! The DSP a jitter buffer needs when the network does not hand over exactly one
//! block of audio per block of playout.
//!
//! Shaped after WebRTC's NetEq (`modules/audio_coding/neteq` in Chromium), adapted
//! to moq. Three things differ from the original:
//!
//! - **PCM in, PCM out.** Decoding stays outside: [`decode`](crate::decode) turns
//!   Opus, AAC, or raw PCM into interleaved `f32` and hands it over. Nothing here
//!   knows a codec, so the same engine serves every rendition.
//! - **The sink pulls.** The speaker asks for one [`BLOCK`] at a time on the device
//!   clock, the way NetEq's `GetAudio` is called every 10 ms, so playout never waits
//!   on a network read.
//! - **`f32` samples, `f64` arithmetic.** NetEq is fixed point (Q15 samples, Q14
//!   gains) because it targets DSPs. We are not bit-exact with it and do not try to
//!   be: the constants and the algorithm shapes are the specification, the fixed
//!   point is not.
//!
//! PCM is interleaved `f32` throughout, matching
//! [`Decoded::samples`](crate::decode::Decoded::samples) and what the playback sink
//! pushes to the device, and "frames" means samples per channel. Every length here
//! derives from the sample rate, so 44.1 kHz AAC works as well as 48 kHz Opus.
//!
//! The roles, and where each one lives:
//!
//! | Role | Mirrors | Status |
//! | --- | --- | --- |
//! | [`stretch`] accelerate / preemptive expand | `accelerate.cc`, `preemptive_expand.cc`, `time_stretch.cc` | here |
//! | [`expand`] concealment | `expand.cc` | here |
//! | [`merge`] splice back to real audio | `merge.cc` | here |
//! | [`noise`] background estimate and comfort noise | `background_noise.cc` | here |
//! | [`level`] smoothed buffer level | `buffer_level_filter.cc` | here |
//! | [`sync`] committed-but-unplayed PCM | `sync_buffer.cc` | here |
//! | [`delay`] target estimator and constraints | `delay_manager.cc`, `underrun_optimizer.cc`, `delay_constraints.cc` | here, to `doc/concept/playout.md` |
//! | [`buffer`] frame buffer and flushing | `packet_buffer.cc` | here |
//! | [`decision`] per-block decision loop | `decision_logic.cc` | here |
//! | [`engine`] the loop that runs them all | `neteq_impl.cc` | here |
//!
//! [`decode::Consumer`](crate::decode::Consumer) is what drives it: it measures
//! arrivals off the container, feeds the engine decoded PCM, and hands its caller one
//! block per [`read`](crate::decode::Consumer::read).

use std::time::Duration;

pub(crate) mod buffer;
pub(crate) mod decision;
pub(crate) mod delay;
pub(crate) mod engine;
pub(crate) mod expand;
pub(crate) mod level;
pub(crate) mod merge;
pub(crate) mod noise;
pub(crate) mod stretch;
pub(crate) mod sync;

#[cfg(test)]
mod corpus;
#[cfg(test)]
mod fixture;
#[cfg(test)]
mod replay;

/// One block of playout: what the sink pulls, and what concealment produces per call.
pub(crate) const BLOCK: Duration = Duration::from_millis(10);

/// The crossfade a splice gets when the operation does not pick its own length.
pub(crate) const OVERLAP: Duration = Duration::from_micros(5_000);

/// Shortest pitch period searched, so 400 Hz and up.
pub(crate) const MIN_LAG: Duration = Duration::from_micros(2_500);

/// Longest pitch period searched, so 66 Hz and up, and the point a time stretch
/// splices at.
pub(crate) const MAX_LAG: Duration = Duration::from_millis(15);

/// The window a time stretch correlates over, taken from the 15 ms mark.
pub(crate) const SEARCH: Duration = Duration::from_micros(12_500);

/// The coarse pitch search runs here, not at the input rate: 50 lags of a 4 kHz
/// decimation cost a fraction of the same search at 48 kHz and land within one
/// decimated sample, which the full-rate check that follows then refines.
pub(crate) const DECIMATED: u32 = 4_000;

/// Correlation a time stretch needs before it will splice active speech.
pub(crate) const CORRELATION: f32 = 0.9;

/// Correlation fast accelerate settles for, because a buffer that far above target
/// is going to be late either way.
pub(crate) const CORRELATION_FAST: f32 = 0.5;

/// How far above the background a block must sit to count as speech. Below it the
/// correlation is meaningless and a splice is inaudible, so it is always allowed.
pub(crate) const PASSIVE_GATE: f32 = 8.0;

/// The most one run of time stretches can move the playhead, and so the headroom
/// every buffer above the engine needs: the deepest single splice, once per cooldown
/// interval, over the estimator's own resample interval.
pub(crate) const STRETCH_BOUND: Duration = Duration::from_millis(75);

/// Concealment blocks produced back to back before the output is comfort noise and
/// nothing else, so a dead stream does not repeat a pitch period forever.
pub(crate) const MAX_CONSECUTIVE_EXPANDS: u32 = 200;

/// How much further than the target audio may arrive and still be played.
///
/// Three terms, each one something playout absorbs without dropping a sample: the
/// estimator reports a bucket's upper edge, so the real delay sits up to a bucket
/// below it; the output leaves a block at a time; and a time stretch moves the
/// playhead by up to its own bound.
///
/// It is both the gap an age budget has to keep above the target, and therefore the
/// amount a budget has to be deeper than the target it will allow.
pub(crate) const HEADROOM: Duration =
	Duration::from_millis(delay::BUCKET as u64 + BLOCK.as_millis() as u64 + STRETCH_BOUND.as_millis() as u64);

/// Frames in `duration` at `rate`.
pub(crate) fn frames(rate: u32, duration: Duration) -> usize {
	(f64::from(rate) * duration.as_secs_f64()).round() as usize
}

/// The deterministic noise source behind the unvoiced and comfort-noise parts.
///
/// NetEq draws from a fixed table plus an LCG so its output is reproducible across
/// builds (`random_vector.cc`). A xorshift gives us the same property without a
/// table or a dependency, and the same sample feeds every channel so a correlated
/// stereo image stays correlated.
pub(crate) struct Rng(u64);

impl Rng {
	/// A generator seeded for reproducible output.
	pub(crate) fn new() -> Self {
		Self(0x2545_F491_4F6C_DD1D)
	}

	/// The next sample: white noise with unit variance, so a filter driven by it
	/// comes out at the gain it was given.
	pub(crate) fn sample(&mut self) -> f32 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		let uniform = ((self.0 >> 40) as f32) / (1u64 << 23) as f32 - 1.0;
		uniform * 3f32.sqrt()
	}
}

impl Default for Rng {
	fn default() -> Self {
		Self::new()
	}
}

/// Resample `input` down to `out.len()` samples at 4 kHz.
///
/// NetEq keeps a 3 to 7 tap FIR per supported rate (`dsp_helper.cc`), all of them
/// integer decimations of 8, 16, 32, or 48 kHz. We take 44.1 kHz too, where the
/// ratio is not an integer, so this is a boxcar average over one decimation span
/// instead: the same job, one tap count short of the same stopband, and the coarse
/// search that consumes it only needs the peak location.
pub(crate) fn decimate(input: &[f32], out: &mut [f32]) {
	debug_assert!(!out.is_empty() && input.len() >= out.len());

	let step = input.len() as f64 / out.len() as f64;
	let width = (step.round() as usize).max(1);

	for (i, sample) in out.iter_mut().enumerate() {
		let start = ((i as f64) * step).round() as usize;
		let end = (start + width).min(input.len());
		let span = &input[start.min(end)..end];
		*sample = span.iter().sum::<f32>() / span.len().max(1) as f32;
	}
}

/// Copy one channel out of an interleaved buffer.
pub(crate) fn channel(input: &[f32], channels: usize, index: usize) -> Vec<f32> {
	input[index..].iter().step_by(channels).copied().collect()
}

/// The fade-out weight at `i` of a `len` sample linear crossfade.
///
/// NetEq steps a Q14 factor down by `16384 / (len + 1)` per sample
/// (`audio_multi_vector.cc`), so the fade starts at full old signal and stops one
/// step short of full new signal.
pub(crate) fn fade(i: usize, len: usize) -> f32 {
	1.0 - (i as f32) / ((len + 1) as f32)
}
