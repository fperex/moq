//! Decoded audio waiting to be played, in media order.
//!
//! Mirrors `packet_buffer.cc`, with PCM in place of packets: [`decode`](crate::decode)
//! has already run by the time anything reaches here, so a "packet" is a run of
//! interleaved samples with the media time of its first frame.
//!
//! Three things it has to get right, all of which the wire hands it routinely:
//!
//! - **Order.** Groups arrive out of order, so an insert lands wherever its
//!   timestamp says rather than at the back.
//! - **Holes.** A skipped group leaves media missing in the middle. The buffer says
//!   how much runs contiguously from the front, which is what the decision loop can
//!   play without a splice, and where the audio after a hole picks up.
//! - **Overfill.** A publisher flushing a burst, or a receiver that stalled and came
//!   back, can hold far more than playout wants. Above a multiple of the target the
//!   oldest audio is dropped back to the target ([`Self::flush`]), because the
//!   alternative is playing every one of those samples late.

use std::collections::VecDeque;
use std::time::Duration;

use super::frames;

/// How far apart two timestamps may sit and still count as the same run.
///
/// Timestamps reach us in microseconds, and a decoder's own rounding moves the
/// boundary between two packets by less than that. A real hole is a frame wide at
/// the very least, so this separates rounding from media that is actually missing.
const TOLERANCE: Duration = Duration::from_millis(1);

/// How far above the target the buffer may fill before the oldest audio is dropped
/// rather than played late, NetEq's `target_level_multiplier`.
const OVERFULL: u32 = 4;

/// One decoded run of audio: interleaved samples and where they belong.
struct Packet {
	/// Media time of the first frame still held, so it moves as the front is played.
	timestamp: Duration,
	/// Interleaved samples, with the played ones already drained off the front.
	pcm: Vec<f32>,
}

/// Decoded audio held for playout, keyed by media time.
pub(crate) struct Buffer {
	rate: u32,
	channels: usize,
	packets: VecDeque<Packet>,
	/// Media consumed so far, so a straggler for audio already played is dropped
	/// rather than replayed out of order.
	floor: Option<Duration>,
}

impl Buffer {
	/// An empty buffer for interleaved `channels` channel PCM at `rate`.
	pub(crate) fn new(rate: u32, channels: usize) -> Self {
		Self {
			rate,
			channels: channels.max(1),
			packets: VecDeque::new(),
			floor: None,
		}
	}

	/// Hold `pcm`, which starts at media time `timestamp`.
	///
	/// Audio overlapping what is already held, or what has already been played, is
	/// trimmed rather than stacked: a straggler for a moment that has passed would
	/// step the timeline backwards, and the same media held twice plays twice.
	pub(crate) fn insert(&mut self, timestamp: Duration, pcm: &[f32]) {
		let mut start = timestamp;
		let mut pcm = pcm;

		// A packet straddling the playhead still has a usable tail, so trim rather
		// than drop.
		if let Some(floor) = self.floor
			&& !self.trim(&mut start, &mut pcm, floor)
		{
			return;
		}

		let at = self
			.packets
			.iter()
			.position(|packet| packet.timestamp > start)
			.unwrap_or(self.packets.len());

		if at > 0 {
			let previous = &self.packets[at - 1];
			let end = previous.timestamp + self.duration(previous.pcm.len() / self.channels);
			if !self.trim(&mut start, &mut pcm, end) {
				return;
			}
		}

		// And cut the tail where the audio already held after it begins.
		if let Some(next) = self.packets.get(at) {
			let room = next.timestamp.saturating_sub(start);
			let keep = frames(self.rate, room).min(pcm.len() / self.channels);
			if keep == 0 {
				return;
			}
			pcm = &pcm[..keep * self.channels];
		}

		self.packets.insert(
			at,
			Packet {
				timestamp: start,
				pcm: pcm.to_vec(),
			},
		);
	}

	/// Drop everything before `floor`, reporting whether anything is left.
	fn trim(&self, start: &mut Duration, pcm: &mut &[f32], floor: Duration) -> bool {
		if *start + TOLERANCE >= floor {
			return !pcm.is_empty();
		}

		let skip = frames(self.rate, floor - *start);
		if skip * self.channels >= pcm.len() {
			return false;
		}

		*pcm = &pcm[skip * self.channels..];
		*start = floor;
		true
	}

	/// Media time of the next sample held, or `None` when the buffer is empty.
	pub(crate) fn front(&self) -> Option<Duration> {
		self.packets.front().map(|packet| packet.timestamp)
	}

	/// Frames that run contiguously from the front, which is what can be played
	/// without splicing over a hole.
	pub(crate) fn ready(&self) -> usize {
		let mut ready = 0;
		let mut end = None;

		for packet in &self.packets {
			if end.is_some_and(|end: Duration| packet.timestamp > end + TOLERANCE) {
				break;
			}
			let count = packet.pcm.len() / self.channels;
			ready += count;
			end = Some(packet.timestamp + self.duration(count));
		}

		ready
	}

	/// The contiguous run from the front, as media time.
	pub(crate) fn buffered(&self) -> Duration {
		self.duration(self.ready())
	}

	/// Take up to `count` contiguous frames off the front, appending them to `out`
	/// and returning how many frames were taken.
	pub(crate) fn take(&mut self, count: usize, out: &mut Vec<f32>) -> usize {
		let count = count.min(self.ready());
		let start = self.front();
		let mut taken = 0;

		while taken < count {
			let rate = self.rate;
			let channels = self.channels;
			let packet = self.packets.front_mut().expect("contiguous frames are held");
			let held = packet.pcm.len() / channels;
			let wanted = (count - taken).min(held);

			out.extend_from_slice(&packet.pcm[..wanted * channels]);
			taken += wanted;

			if wanted == held {
				self.packets.pop_front();
			} else {
				packet.pcm.drain(..wanted * channels);
				packet.timestamp += duration(rate, wanted);
			}
		}

		if let Some(start) = start.filter(|_| taken > 0) {
			self.floor = Some(start + self.duration(taken));
		}

		taken
	}

	/// Drop the oldest audio back to `target` once more than `threshold` is held,
	/// reporting the frames thrown away.
	///
	/// The alternative to dropping is playing every one of those samples late, which
	/// is the delay the target exists to bound. NetEq flushes partially for the same
	/// reason: a full flush would take the audio that is about to play with it.
	///
	/// The threshold applied is the looser of `threshold` and [`OVERFULL`] times the
	/// target, which is NetEq's. A flush that convicted audio the decision loop was
	/// about to stretch away would take back the very cushion the loop needs, so a
	/// caller asking for less than the multiple is not given it; what a caller can do
	/// is hold more, which is what the decision loop's own skip ceiling does once the
	/// target is small enough that four times it is inside that ceiling.
	pub(crate) fn flush(&mut self, target: Duration, threshold: Duration) -> usize {
		let target = target.max(self.duration(1));
		match self.buffered() > threshold.max(target * OVERFULL) {
			true => self.drop_to(target),
			false => 0,
		}
	}

	/// Drop the oldest audio until no more than `target` is held, reporting the
	/// frames thrown away.
	///
	/// What the caller is choosing between is dropping this audio and playing it
	/// late, so the audio dropped is the oldest: it is the part that would be late.
	fn drop_to(&mut self, target: Duration) -> usize {
		let buffered = self.buffered();
		if buffered <= target {
			return 0;
		}

		let excess = frames(self.rate, buffered - target);
		let mut dropped = 0;

		while dropped < excess {
			let rate = self.rate;
			let channels = self.channels;
			let packet = self.packets.front_mut().expect("more than the target is held");
			let held = packet.pcm.len() / channels;
			let wanted = (excess - dropped).min(held);

			dropped += wanted;
			if wanted == held {
				self.packets.pop_front();
			} else {
				packet.pcm.drain(..wanted * channels);
				packet.timestamp += duration(rate, wanted);
			}
		}

		self.floor = self.front();
		dropped
	}

	/// Drop everything, for a timeline that restarted somewhere else.
	pub(crate) fn clear(&mut self) {
		self.packets.clear();
		self.floor = None;
	}

	/// How long `count` frames last at this buffer's rate.
	pub(crate) fn duration(&self, count: usize) -> Duration {
		duration(self.rate, count)
	}
}

/// How long `count` frames last at `rate`.
fn duration(rate: u32, count: usize) -> Duration {
	Duration::from_secs_f64(count as f64 / f64::from(rate))
}

#[cfg(test)]
mod tests {
	use super::*;

	const RATE: u32 = 48_000;

	fn ms(ms: u64) -> Duration {
		Duration::from_millis(ms)
	}

	/// One 10 ms mono block whose samples all read `value`.
	fn block(value: f32) -> Vec<f32> {
		vec![value; frames(RATE, ms(10))]
	}

	#[test]
	fn plays_back_what_it_was_given() {
		let mut buffer = Buffer::new(RATE, 1);
		buffer.insert(ms(0), &block(1.0));
		buffer.insert(ms(10), &block(2.0));
		assert_eq!(buffer.buffered(), ms(20));

		let mut out = Vec::new();
		assert_eq!(buffer.take(480, &mut out), 480);
		assert!(out.iter().all(|s| *s == 1.0));
		assert_eq!(buffer.front(), Some(ms(10)));
		assert_eq!(buffer.buffered(), ms(10));
	}

	#[test]
	fn an_out_of_order_arrival_lands_in_media_order() {
		let mut buffer = Buffer::new(RATE, 1);
		buffer.insert(ms(10), &block(2.0));
		buffer.insert(ms(0), &block(1.0));

		assert_eq!(buffer.front(), Some(ms(0)));
		assert_eq!(buffer.buffered(), ms(20));

		let mut out = Vec::new();
		buffer.take(960, &mut out);
		assert_eq!(out[0], 1.0);
		assert_eq!(out[959], 2.0);
	}

	#[test]
	fn a_hole_bounds_what_is_playable() {
		let mut buffer = Buffer::new(RATE, 1);
		buffer.insert(ms(0), &block(1.0));
		buffer.insert(ms(30), &block(3.0));

		assert_eq!(buffer.buffered(), ms(10), "the audio past the hole is not contiguous");

		let mut out = Vec::new();
		assert_eq!(buffer.take(960, &mut out), 480, "a take stops at the hole");

		// Past the hole the audio is playable again, which is where a splice picks up.
		assert_eq!(buffer.buffered(), ms(10));
		assert_eq!(buffer.front(), Some(ms(30)));
	}

	#[test]
	fn a_straggler_for_played_audio_is_dropped() {
		let mut buffer = Buffer::new(RATE, 1);
		buffer.insert(ms(0), &block(1.0));
		let mut out = Vec::new();
		buffer.take(480, &mut out);

		buffer.insert(ms(0), &block(9.0));
		assert_eq!(buffer.buffered(), Duration::ZERO, "audio already played came back");
	}

	#[test]
	fn a_straggler_straddling_the_playhead_keeps_its_tail() {
		let mut buffer = Buffer::new(RATE, 1);
		buffer.insert(ms(0), &block(1.0));
		let mut out = Vec::new();
		buffer.take(240, &mut out);

		// A 20 ms packet whose first half is audio already held or played.
		let mut late = block(5.0);
		late.extend(block(5.0));
		buffer.insert(ms(0), &late);
		// 5 ms of the original packet, then the 10 ms the late one adds past it.
		assert_eq!(buffer.buffered(), ms(15), "the unplayed tail was dropped with the head");
		assert_eq!(buffer.front(), Some(ms(5)));
	}

	#[test]
	fn an_overfull_buffer_drops_back_to_the_target() {
		let mut buffer = Buffer::new(RATE, 1);
		for i in 0..100 {
			buffer.insert(ms(i * 10), &block(i as f32));
		}
		assert_eq!(buffer.buffered(), ms(1000));

		assert_eq!(buffer.flush(ms(100), ms(400)), frames(RATE, ms(900)));
		assert_eq!(buffer.buffered(), ms(100));
		assert_eq!(buffer.front(), Some(ms(900)), "the newest audio is what was kept");
	}

	#[test]
	fn a_threshold_under_the_multiple_does_not_tighten_the_flush() {
		let mut buffer = Buffer::new(RATE, 1);
		for i in 0..30 {
			buffer.insert(ms(i * 10), &block(1.0));
		}
		assert_eq!(buffer.buffered(), ms(300));

		// 200ms is over what the caller asked to hold and inside four times the target. The looser
		// of the two wins, because the decision loop would have stretched this audio away rather
		// than lost it: pinned here, since tightening it costs `Engine` a skip on every small target.
		assert_eq!(buffer.flush(ms(100), ms(200)), 0);
		assert_eq!(buffer.buffered(), ms(300));
	}

	#[test]
	fn a_buffer_within_the_multiple_is_left_alone() {
		let mut buffer = Buffer::new(RATE, 1);
		for i in 0..30 {
			buffer.insert(ms(i * 10), &block(1.0));
		}
		assert_eq!(
			buffer.flush(ms(100), ms(400)),
			0,
			"300ms is inside four times the target"
		);
		assert_eq!(buffer.buffered(), ms(300));
	}

	#[test]
	fn stereo_frames_stay_paired() {
		let mut buffer = Buffer::new(RATE, 2);
		let pcm: Vec<f32> = (0..960).flat_map(|i| [i as f32, -(i as f32)]).collect();
		buffer.insert(ms(0), &pcm);
		assert_eq!(buffer.buffered(), ms(20));

		let mut out = Vec::new();
		buffer.take(480, &mut out);
		assert_eq!(out.len(), 960);
		assert_eq!(out[0], 0.0);
		assert_eq!(out[1], -0.0);
		assert_eq!(buffer.front(), Some(ms(10)));
	}

	#[test]
	fn a_rounded_timestamp_is_not_a_hole() {
		let mut buffer = Buffer::new(RATE, 1);
		buffer.insert(ms(0), &block(1.0));
		// 10.4 ms: a millisecond-stamped ingest, not media that is missing.
		buffer.insert(Duration::from_micros(10_400), &block(2.0));
		assert!(buffer.buffered() >= ms(20));
	}
}
