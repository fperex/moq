//! The `play` verb's command-line surface.

use std::time::Duration;

use moq_mux::catalog::CatalogFormat;

use crate::subscribe::{CatalogFormatArg, SelectArgs};

/// The deepest buffer playout can be asked for, which is what bounds `--delay`.
///
/// The estimator describes delay with a hundred twenty millisecond buckets
/// (`doc/concept/playout.md`), so two seconds is the widest target it can produce
/// and the widest floor it can be held to. Duplicated as a number because this
/// module compiles without the `play` feature, and so without `moq-audio`.
const DELAY_MAX: Duration = Duration::from_secs(2);

/// Play one MoQ broadcast through a native window and speaker.
#[derive(usage::Args, Clone)]
#[usage(unknown_flags = "error", args_override_self = false)]
pub struct Args {
	/// Catalog format, detected from the broadcast suffix when omitted.
	#[usage(long, value_enum)]
	pub catalog_format: Option<CatalogFormatArg>,

	/// The least playback trails the live edge.
	///
	/// A floor, not a fixed delay: the jitter buffer measures what actually arrives and
	/// holds at least this much, more when the path asks for it. Every frame is presented
	/// that long after the live edge, which is how late one may arrive and still make its
	/// slot, and the staleness budget is sized from it, since nothing older than the
	/// playhead is worth presenting. The picture follows the speaker either way.
	#[usage(long, default = "100ms")]
	pub delay: moq_tokio::Duration,

	/// Rendition selection by track name or codec.
	#[usage(flatten)]
	pub select: SelectArgs,
}

impl Args {
	pub(super) fn catalog_format(&self, broadcast: &str) -> CatalogFormat {
		self.catalog_format
			.map(Into::into)
			.or_else(|| CatalogFormat::detect(broadcast))
			.unwrap_or_default()
	}

	/// Reject a codec the local decoders can't open.
	///
	/// The selection flags are shared with the stdout exports, which pass bytes
	/// through and so accept every codec the catalog can name. Asking for one of
	/// those here would filter the catalog down to a rendition that then fails to
	/// decode, leaving a blank window rather than an error.
	pub fn validate(&self) -> anyhow::Result<()> {
		use crate::subscribe::VideoCodecArg;

		anyhow::ensure!(
			!matches!(self.select.video_codec, Some(VideoCodecArg::Vp8 | VideoCodecArg::Vp9)),
			"`play` cannot decode vp8 or vp9; pass --video-codec h264, h265, or av1"
		);
		// A floor deeper than the estimator can describe would be refused when the
		// decoder is built, which is after the pipeline has opened a device.
		anyhow::ensure!(
			self.delay.into_std() <= DELAY_MAX,
			"--delay must be at most {DELAY_MAX:?}; it is the least audio playout buffers"
		);
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[derive(usage::Cli)]
	struct Cli {
		#[usage(flatten)]
		args: Args,
	}

	fn parse(flags: &[&str]) -> Args {
		let argv: Vec<&std::ffi::OsStr> = flags.iter().map(std::ffi::OsStr::new).collect();
		Cli::parse_from(&argv).expect("parse the play flags").args
	}

	/// The selection flags are shared with the stdout exports, which pass every
	/// codec through, so a codec the local decoders can't open is only caught
	/// here. Missing it leaves a blank window rather than an error.
	#[test]
	fn undecodable_video_codecs_are_refused() {
		parse(&[]).validate().unwrap();
		parse(&["--video-codec", "h264"]).validate().unwrap();
		parse(&["--video-codec", "av1"]).validate().unwrap();

		let err = parse(&["--video-codec", "vp9"]).validate().unwrap_err().to_string();
		assert!(err.contains("vp8 or vp9"), "{err}");
		assert!(parse(&["--video-codec", "vp8"]).validate().is_err());
	}

	/// The delay is the floor under the playout buffer and what the staleness budget
	/// is sized from, so its default has to be one a live stream can present against.
	#[test]
	fn the_delay_sets_the_staleness_budget() {
		assert_eq!(parse(&[]).delay.into_std(), std::time::Duration::from_millis(100));
		assert_eq!(
			parse(&["--delay", "500ms"]).delay.into_std(),
			std::time::Duration::from_millis(500)
		);
	}

	/// `moq play --help` is what `doc/bin/cli.md` describes, so the page has to say
	/// `--delay` is a floor. A doc that still calls it the speaker's ring depth is a
	/// doc for a player that no longer exists.
	#[cfg(feature = "play")]
	#[test]
	fn the_help_page_calls_the_delay_a_floor() {
		let Err(err) = crate::args::Invocation::try_parse_from(["moq", "play", "--help"]) else {
			panic!("--help parsed instead of asking a question")
		};
		assert_eq!(err.kind(), crate::args::ParseErrorKind::DisplayHelp);

		let help = err.to_string();
		assert!(help.contains("--delay"), "{help}");
		assert!(help.contains("The least playback trails the live edge"), "{help}");
		assert!(help.contains("100ms"), "{help}");
	}

	/// The playout budget has one spelling because it always controls both
	/// presentation delay and media staleness.
	#[test]
	fn the_playout_budget_has_one_flag() {
		for removed in [["--max-age", "500ms"], ["--latency-max", "500ms"]] {
			let argv: Vec<&std::ffi::OsStr> = removed.iter().map(std::ffi::OsStr::new).collect();
			assert!(Cli::parse_from(&argv).is_err(), "{} still parsed", removed[0]);
		}
	}

	/// A floor deeper than the estimator can describe is refused up front, rather
	/// than after the pipeline has opened a device.
	#[test]
	fn the_delay_is_bounded_by_what_playout_can_hold() {
		let err = parse(&["--delay", "3s"]).validate().unwrap_err().to_string();
		assert!(err.contains("--delay must be at most"), "{err}");
		parse(&["--delay", "2s"]).validate().unwrap();

		// The bound has to be playout's own, which only a build carrying playout
		// can say.
		#[cfg(feature = "play")]
		assert_eq!(DELAY_MAX, moq_audio::decode::Config::DELAY_MAX);
	}

	/// The suffix picks the format, and the flag overrides it.
	#[test]
	fn the_catalog_format_follows_the_broadcast_suffix() {
		assert_eq!(parse(&[]).catalog_format("room.hang"), CatalogFormat::Hang);
		assert_eq!(parse(&[]).catalog_format("room.msf"), CatalogFormat::Msf);
		assert_eq!(parse(&[]).catalog_format("room"), CatalogFormat::DEFAULT);
		assert_eq!(
			parse(&["--catalog-format", "hangz"]).catalog_format("room.msf"),
			CatalogFormat::HangZ
		);
	}
}
