use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::Parser;
use moq_shaper::{Config, Profile, Shaper};

/// Forward UDP between a client and an upstream, impairing the path on the way.
#[derive(Parser)]
struct Args {
	/// The address clients connect to instead of the upstream.
	#[arg(long)]
	listen: SocketAddr,

	/// The address every datagram is forwarded to.
	#[arg(long)]
	upstream: SocketAddr,

	/// A built-in profile name, or a path to a profile TOML file.
	#[arg(long)]
	profile: String,

	/// Override the profile's seed, so a failing run can be replayed.
	#[arg(long)]
	seed: Option<u64>,

	/// Write the final counters to this file as JSON on exit.
	#[arg(long)]
	report: Option<PathBuf>,

	/// Print one JSON line of counters to stdout this often.
	#[arg(long, value_parser = humantime::parse_duration)]
	report_interval: Option<Duration>,

	/// Also proxy TCP on the listen port, unimpaired, so HTTP on that port still answers.
	#[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
	tcp_passthrough: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
	// Logs go to stderr so stdout carries nothing but the report lines a harness parses.
	tracing_subscriber::fmt().with_writer(std::io::stderr).init();

	let args = Args::parse();
	let mut profile = Profile::parse(&args.profile)?;
	if let Some(seed) = args.seed {
		profile.seed = seed;
	}

	let shaper = Arc::new(
		Shaper::bind(Config {
			listen: args.listen,
			upstream: args.upstream,
			profile: profile.clone(),
			tcp_passthrough: args.tcp_passthrough,
		})
		.await?,
	);

	tracing::info!(
		listen = %shaper.local_addr(),
		upstream = %args.upstream,
		profile = %profile.name,
		seed = profile.seed,
		tcp_passthrough = args.tcp_passthrough,
		"shaping"
	);

	let running = shaper.clone();
	let mut run = tokio::spawn(async move { running.run().await });

	// The first tick fires after a full interval, so a run reports what it did rather
	// than an empty line at startup.
	let mut interval = args
		.report_interval
		.map(|period| tokio::time::interval_at(tokio::time::Instant::now() + period, period));

	loop {
		tokio::select! {
			res = &mut run => {
				res.context("the shaper task panicked")??;
				anyhow::bail!("the shaper stopped on its own");
			},
			_ = tick(&mut interval) => {
				let mut stdout = std::io::stdout().lock();
				serde_json::to_writer(&mut stdout, &shaper.report())?;
				stdout.write_all(b"\n")?;
				stdout.flush()?;
			},
			res = shutdown() => {
				res?;
				break;
			},
		}
	}

	let report = shaper.report();
	tracing::info!(up = ?report.up, down = ?report.down, "stopping");

	if let Some(path) = &args.report {
		let json = serde_json::to_vec(&report)?;
		std::fs::write(path, json).with_context(|| format!("failed to write {}", path.display()))?;
	}

	Ok(())
}

/// The next report tick, or never when reporting is off.
async fn tick(interval: &mut Option<tokio::time::Interval>) {
	match interval {
		Some(interval) => {
			interval.tick().await;
		}
		None => std::future::pending().await,
	}
}

/// Resolves on the first signal asking the shaper to stop.
async fn shutdown() -> anyhow::Result<()> {
	#[cfg(unix)]
	{
		let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
		tokio::select! {
			res = tokio::signal::ctrl_c() => res?,
			_ = term.recv() => {},
		}
	}

	#[cfg(not(unix))]
	tokio::signal::ctrl_c().await?;

	Ok(())
}
