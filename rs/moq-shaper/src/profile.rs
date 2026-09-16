use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};

/// The profiles shipped under `profiles/`, embedded so a binary needs no data files.
const BUILTIN: &[(&str, &str)] = &[
	("near-zero", include_str!("../profiles/near-zero.toml")),
	("mild", include_str!("../profiles/mild.toml")),
	("bursty", include_str!("../profiles/bursty.toml")),
	("step", include_str!("../profiles/step.toml")),
	("high-rtt", include_str!("../profiles/high-rtt.toml")),
	("lossy", include_str!("../profiles/lossy.toml")),
];

/// How the shaper treats each direction of the path.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Profile {
	/// The profile's name, recorded alongside a run's counters.
	pub name: String,

	/// Seeds both directions' generators, each deriving its own, so the same run makes the
	/// same decisions.
	pub seed: u64,

	/// Treatment of datagrams travelling from the client to the upstream.
	pub up: Direction,

	/// Treatment of datagrams travelling back from the upstream to the client.
	pub down: Direction,
}

impl Profile {
	/// Load a built-in profile by name, or a profile TOML file by path.
	pub fn parse(name_or_path: &str) -> anyhow::Result<Self> {
		let toml = match BUILTIN.iter().find(|(name, _)| *name == name_or_path) {
			Some((_, toml)) => (*toml).to_string(),
			None => Self::read(Path::new(name_or_path))?,
		};

		let profile: Self =
			toml::from_str(&toml).with_context(|| format!("failed to parse profile {name_or_path:?}"))?;
		profile.validate()?;
		Ok(profile)
	}

	/// The built-in profile names.
	pub fn names() -> impl Iterator<Item = &'static str> {
		BUILTIN.iter().map(|(name, _)| *name)
	}

	/// An unknown name is almost always a typo, so say what the alternatives were.
	fn read(path: &Path) -> anyhow::Result<String> {
		std::fs::read_to_string(path).with_context(|| {
			let names: Vec<_> = Self::names().collect();
			format!(
				"no built-in profile or readable file named {path:?}; built-ins are {}",
				names.join(", ")
			)
		})
	}

	fn validate(&self) -> anyhow::Result<()> {
		anyhow::ensure!(!self.name.is_empty(), "profile is missing a name");
		self.up.validate("up")?;
		self.down.validate("down")?;
		Ok(())
	}
}

/// One direction's treatment: what is dropped, how late it arrives, and how fast it may flow.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Direction {
	/// Added to every datagram's delivery time.
	#[serde(with = "humantime_serde")]
	pub delay: Duration,

	/// Sigma of a gaussian added to `delay`, never negative and never past the datagram in front.
	#[serde(with = "humantime_serde")]
	pub jitter: Duration,

	/// Hold datagrams and release them together, the way a paced sender bunches them.
	pub burst: Option<Burst>,

	/// The fraction of datagrams discarded, from 0 to 1.
	pub loss: f64,

	/// The fraction of datagrams pushed back by `reorder_delay`, from 0 to 1.
	pub reorder: f64,

	/// How much later a reordered datagram is delivered.
	#[serde(with = "humantime_serde")]
	pub reorder_delay: Duration,

	/// A token bucket applied to this direction.
	pub rate: Option<ByteRate>,

	/// Switch to a different delay part-way through the run.
	pub step: Option<Step>,
}

impl Direction {
	fn validate(&self, which: &str) -> anyhow::Result<()> {
		anyhow::ensure!(
			(0.0..=1.0).contains(&self.loss),
			"{which}.loss must be between 0 and 1, got {}",
			self.loss
		);
		anyhow::ensure!(
			(0.0..=1.0).contains(&self.reorder),
			"{which}.reorder must be between 0 and 1, got {}",
			self.reorder
		);
		anyhow::ensure!(
			self.reorder == 0.0 || !self.reorder_delay.is_zero(),
			"{which}.reorder_delay must be greater than 0 when {which}.reorder is set"
		);

		if let Some(burst) = self.burst {
			anyhow::ensure!(burst.count > 0, "{which}.burst.count must be at least 1");
			anyhow::ensure!(!burst.window.is_zero(), "{which}.burst.window must be greater than 0");
		}

		if let Some(rate) = self.rate {
			anyhow::ensure!(
				rate.bytes_per_second > 0,
				"{which}.rate.bytes_per_second must be at least 1"
			);
			anyhow::ensure!(rate.burst_bytes > 0, "{which}.rate.burst_bytes must be at least 1");
		}

		Ok(())
	}
}

/// Hold up to `count` datagrams, or until `window` elapses, then release them together.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Burst {
	/// How many datagrams close a batch early.
	pub count: usize,

	/// How long a batch waits for that many to arrive.
	#[serde(with = "humantime_serde")]
	pub window: Duration,
}

/// A token bucket: a sustained byte rate plus how far a sender may run ahead of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ByteRate {
	/// The sustained rate the bucket refills at.
	pub bytes_per_second: u64,

	/// The bucket's capacity, so a burst up to this size passes untouched.
	pub burst_bytes: u64,
}

/// Replace the direction's delay and jitter once the run reaches `at`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Step {
	/// How far into the run the switch happens.
	#[serde(with = "humantime_serde")]
	pub at: Duration,

	/// The delay from then on.
	#[serde(with = "humantime_serde")]
	pub delay: Duration,

	/// The jitter sigma from then on. A step that omits it switches jitter off.
	#[serde(with = "humantime_serde")]
	pub jitter: Duration,
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn builtins_parse_and_are_named_after_their_file() {
		for name in Profile::names() {
			let profile = Profile::parse(name).expect("built-in profile failed to parse");
			assert_eq!(profile.name, name);
		}
	}

	#[test]
	fn builtins_are_impairing_except_the_control() {
		for name in Profile::names() {
			let profile = Profile::parse(name).unwrap();
			let idle = profile.up == Direction::default() && profile.down == Direction::default();
			assert_eq!(idle, name == "near-zero", "{name} treats the wrong amount of traffic");
		}
	}

	#[test]
	fn an_unknown_name_lists_the_builtins() {
		let err = Profile::parse("nope").unwrap_err().to_string();
		assert!(err.contains("near-zero"), "{err}");
	}

	#[test]
	fn an_out_of_range_probability_is_refused() {
		let dir = Direction {
			loss: 1.5,
			..Default::default()
		};
		assert!(dir.validate("up").is_err());
	}

	#[test]
	fn a_reorder_without_a_delay_is_refused() {
		let dir = Direction {
			reorder: 0.5,
			..Default::default()
		};
		let err = dir.validate("up").unwrap_err().to_string();
		assert!(err.contains("reorder_delay"), "{err}");

		let dir = Direction {
			reorder: 0.5,
			reorder_delay: Duration::from_millis(20),
			..Default::default()
		};
		assert!(dir.validate("up").is_ok());
	}

	#[test]
	fn an_unknown_field_is_refused() {
		let err = toml::from_str::<Profile>("name = \"x\"\nwobble = 1\n")
			.unwrap_err()
			.to_string();
		assert!(err.contains("wobble"), "{err}");
	}
}
