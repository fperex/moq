//! SIGINT has to go through the relay's graceful drain.
//!
//! `--drain-timeout` promises that the first shutdown signal sends every session
//! a GOAWAY and keeps serving for that long, so clients reconnect elsewhere
//! instead of being cut off. This raises a real SIGINT at a relay with a live
//! session and checks the promise end to end.
//!
//! The regression it guards: the accept loop installed its own ctrl-C handler
//! and reported the interrupt as end-of-stream, so `serve` returned "stopped
//! accepting connections" in milliseconds and won `Relay::run`'s `select!`
//! against the drain future that deliberately waits out the window. SIGTERM was
//! unaffected (only the drain future watches it), which is how the gap stayed
//! hidden behind systemd while an operator's ctrl-C dropped every session.

#![cfg(unix)]

use std::{net::TcpListener, time::Duration};

use moq_relay::{Config, Relay, auth};

/// Long enough that "exited immediately" and "waited out the window" cannot be
/// confused, short enough to keep the test quick: `Relay::run` sleeps this plus
/// one second before exiting.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

#[test]
fn sigint_drains_sessions_before_exiting() {
	// Same reason as the cluster tests: under `--all-features` a `Connection`
	// carries every transport backend, and holding one across awaits overflows
	// libtest's 2 MiB per-test stack in an unoptimized build.
	std::thread::Builder::new()
		.stack_size(32 * 1024 * 1024)
		.spawn(|| {
			tokio::runtime::Builder::new_current_thread()
				.enable_all()
				.build()
				.expect("build test runtime")
				.block_on(sigint_drains_sessions_before_exiting_inner());
		})
		.expect("spawn test thread")
		.join()
		.expect("test thread panicked");
}

async fn sigint_drains_sessions_before_exiting_inner() {
	let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

	// Install tokio's SIGINT handler before anything raises one: the default
	// disposition would kill the test process instead. Held for the whole test so
	// nothing can conclude the signal is unwatched.
	let _interrupt =
		tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).expect("register SIGINT");

	let (port, config) = relay_config();
	let relay = Relay::load(config).await.expect("load relay");
	let run = tokio::spawn(relay.run());
	wait_listening(port).await;

	let mut client_config = moq_tokio::connect::Config::default();
	client_config.tls.insecure = Some(true);
	let client = client_config.init(Default::default()).expect("client init");
	// One-shot: a reconnecting client would migrate on the GOAWAY and hide whether
	// the original session outlived the signal.
	let url: url::Url = format!("tcp://127.0.0.1:{port}/").parse().expect("parse url");
	let connection = client
		.with_reconnect(false)
		.connect(url)
		.established()
		.await
		.expect("connect");
	let draining = connection.draining().expect("connected");

	let signalled = std::time::Instant::now();
	// SAFETY: `raise` is async-signal-safe, and SIGINT's disposition is tokio's
	// handler, registered above.
	assert_eq!(unsafe { libc::raise(libc::SIGINT) }, 0, "failed to raise SIGINT");

	let goaway = tokio::time::timeout(Duration::from_secs(5), draining.recv())
		.await
		.expect("no GOAWAY within 5s of SIGINT")
		.expect("session closed without a GOAWAY");
	// Empty URI: the relay is restarting, not moving. The window itself is the
	// sender's own timer here (only moq-transport draft-17+ puts it on the wire),
	// so it is the elapsed time below that proves it was honored.
	assert_eq!(goaway.uri, "", "expected a reconnect-to-me GOAWAY");

	// Mid-window the relay is still running: the point of the drain is the time it
	// buys, not the notice. This is what the old ctrl-C race broke.
	tokio::time::sleep(DRAIN_TIMEOUT / 2).await;
	assert!(
		!run.is_finished(),
		"relay exited {:?} after SIGINT, well inside the {DRAIN_TIMEOUT:?} drain window",
		signalled.elapsed()
	);

	// Then it exits on its own, cleanly.
	tokio::time::timeout(Duration::from_secs(15), run)
		.await
		.expect("relay never exited after the drain window")
		.expect("relay task panicked")
		.expect("relay exited with an error");
	assert!(
		signalled.elapsed() >= DRAIN_TIMEOUT,
		"relay exited after {:?}, short of the {DRAIN_TIMEOUT:?} drain window",
		signalled.elapsed()
	);
}

/// A draining relay refuses a new session instead of accepting one and waving it
/// straight back out.
///
/// The regression it guards: the accept loop ran for the whole drain window, so a
/// client redialing during a restart was handed a session that was GOAWAYed a
/// millisecond later. Its reconnect loop scored each one as a failed attempt,
/// retired the predecessor that was still serving its media, and gave up inside
/// the window, which is how a relay restart killed every native publisher on it.
#[test]
fn a_draining_relay_refuses_a_new_session() {
	// Same reason as above: a `Connection` carrying every transport backend
	// overflows libtest's per-test stack in an unoptimized build.
	std::thread::Builder::new()
		.stack_size(32 * 1024 * 1024)
		.spawn(|| {
			tokio::runtime::Builder::new_current_thread()
				.enable_all()
				.build()
				.expect("build test runtime")
				.block_on(a_draining_relay_refuses_a_new_session_inner());
		})
		.expect("spawn test thread")
		.join()
		.expect("test thread panicked");
}

async fn a_draining_relay_refuses_a_new_session_inner() {
	let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

	let (port, config) = relay_config();
	let relay = Relay::load(config).await.expect("load relay");
	// The embedder's trigger rather than a signal: the drain is the same one, and
	// this test is about what the listeners answer during it.
	let origin = relay.cluster().origin.clone();
	let trigger = relay.shutdown_trigger().clone();
	let run = tokio::spawn(relay.run());
	wait_listening(port).await;

	// Something for a session to be served, so the drain below cannot land while
	// the first handshake is still in flight: a session the listener has taken but
	// not yet admitted is refused rather than drained, which is right but is not
	// what this test is about.
	let broadcast = origin.create_broadcast("test").expect("create broadcast");
	broadcast.announce(Default::default()).expect("announce");

	let mut client_config = moq_tokio::connect::Config::default();
	client_config.tls.insecure = Some(true);
	let client = client_config.init(Default::default()).expect("client init");
	let url: url::Url = format!("tcp://127.0.0.1:{port}/").parse().expect("parse url");

	// One-shot throughout: this is about how a dial is answered, not about what a
	// reconnect loop makes of the answer.
	let subscriber = moq_tokio::origin::spawn();
	let consumer = subscriber.consume();
	let mut announced = consumer.announced();
	let connection = client
		.clone()
		.with_reconnect(false)
		.with_subscriber(subscriber)
		.connect(url.clone())
		.established()
		.await
		.expect("connect");
	let draining = connection.draining().expect("connected");

	// The announcement crossing the session is the relay serving it, which is the
	// state the drain has to find for a GOAWAY to be the answer.
	let update = tokio::time::timeout(Duration::from_secs(5), announced.next())
		.await
		.expect("announcement timed out")
		.expect("origin closed");
	assert!(update.kind.is_active(), "expected an announce, got a retraction");

	trigger.start();
	let goaway = tokio::time::timeout(Duration::from_secs(5), draining.recv())
		.await
		.expect("no GOAWAY within 5s of the trigger")
		.expect("session closed without a GOAWAY");
	assert_eq!(goaway.uri, "", "expected a reconnect-to-me GOAWAY");

	// Mid-window the listener is still up, so the refusal below is the relay's
	// answer rather than the socket being gone.
	tokio::net::TcpStream::connect(("127.0.0.1", port))
		.await
		.expect("the listener closed inside the drain window");

	// So a dial is answered, and the answer must never be a session that serves.
	let dialed = tokio::time::timeout(
		Duration::from_secs(5),
		client.with_reconnect(false).connect(url).established(),
	)
	.await
	.expect("the second dial never settled");

	// A transport carrying an HTTP response reports the refusal as the dial's
	// answer. A plain stream transport takes the bytes first, so the same refusal
	// lands as the session closing on arrival, which is what a reconnect loop
	// scores as a severed connection. What must hold on both: nothing that serves,
	// and no GOAWAY, which is the message that would cost the loop its predecessor.
	match dialed {
		Err(err) => {
			if let Some(status) = err.status() {
				assert_eq!(status, 503, "refused with status {status} rather than a retryable 503");
			}
		}
		Ok(refused) => {
			let drained = refused.draining();
			assert!(
				tokio::time::timeout(Duration::from_secs(2), refused.closed())
					.await
					.is_ok(),
				"a draining relay left a new session open"
			);
			assert!(
				drained.and_then(|goaway| goaway.peek()).is_none(),
				"a draining relay sent a GOAWAY to a session it refused"
			);
		}
	}

	// Refusing new sessions must not cut the drain short for the one already being
	// served: the window is what a live publisher rides out.
	assert!(
		!run.is_finished(),
		"relay exited inside the {DRAIN_TIMEOUT:?} drain window"
	);
	drop(connection);

	tokio::time::timeout(Duration::from_secs(15), run)
		.await
		.expect("relay never exited after the drain window")
		.expect("relay task panicked")
		.expect("relay exited with an error");
}

/// A stream-only relay on a free loopback TCP port, fully public, with a short
/// drain window. Returns the port and the config to hand [`Relay::load`].
fn relay_config() -> (u16, Config) {
	// The listener is bound by `Relay::run`, not here, so this leaves the usual
	// probe/bind gap; on loopback it is not worth retrying around.
	let probe = TcpListener::bind("127.0.0.1:0").expect("bind probe");
	let port = probe.local_addr().expect("local addr").port();
	drop(probe);

	// Fully public auth: any no-JWT stream client gets the whole root.
	let mut auth = auth::Config::default();
	auth.public = vec![moq_auth::Pattern::all()];

	let mut config = Config::default();
	config.listen.tcp.bind = Some(format!("127.0.0.1:{port}").parse().expect("parse addr"));
	config.auth = auth;
	config.drain_timeout = DRAIN_TIMEOUT;

	(port, config)
}

async fn wait_listening(port: u16) {
	let deadline = std::time::Instant::now() + Duration::from_secs(5);
	loop {
		if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
			break;
		}
		assert!(
			std::time::Instant::now() < deadline,
			"relay never became ready on port {port}"
		);
		tokio::time::sleep(Duration::from_millis(25)).await;
	}
}
