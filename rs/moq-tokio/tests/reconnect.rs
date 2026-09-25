//! What ends the reconnect loop, and where a peer's GOAWAY can send it.
//!
//! Dials over plain TCP (`tcp://`), which fails fast and locally: no TLS material, no QUIC
//! handshake, no server. That keeps the assertion about the *budget* rather than about how long a
//! particular backend takes to give up.

#![cfg(feature = "tcp")]

use std::net::TcpListener;
use std::time::Duration;

use moq_tokio::moq_net;

/// A client whose reconnect loop escalates fast enough to assert on inside a test.
fn client(backoff: moq_tokio::Backoff) -> moq_tokio::Client {
	let mut config = moq_tokio::connect::Config::default();
	config.backoff = backoff;
	config.init(Default::default()).expect("failed to init client")
}

/// A transient failure is retried, escalating, until the budget runs out. The give-up error names
/// the underlying cause so an operator sees why rather than just "timed out".
#[tokio::test]
async fn a_transient_failure_retries_until_the_budget_runs_out() {
	let mut backoff = moq_tokio::Backoff::default();
	backoff.initial = Duration::from_millis(20);
	backoff.max = Duration::from_millis(40);
	backoff.timeout = Duration::from_millis(200);

	// Nothing listens on port 1, so every attempt is refused: transient as far as this layer knows.
	let url: url::Url = "tcp://127.0.0.1:1".parse().expect("failed to parse url");
	let started = tokio::time::Instant::now();
	let reconnect = client(backoff).connect(url);

	let err = tokio::time::timeout(Duration::from_secs(10), reconnect.closed())
		.await
		.expect("reconnect loop never gave up")
		.expect_err("reconnect loop stopped without an error");

	assert!(
		matches!(err, moq_tokio::Error::Reconnect(_)),
		"stopped with {err} rather than exhausting the budget"
	);
	assert_ne!(
		err.to_string(),
		"reconnect timed out after 200ms",
		"give-up error lost the underlying cause"
	);
	// The budget is spent on sleeping between attempts, so reaching it takes at least most of it.
	// Jitter draws each delay from the top half of its window, hence half rather than the whole.
	assert!(
		started.elapsed() >= Duration::from_millis(100),
		"gave up after {:?} without retrying",
		started.elapsed()
	);
}

/// The epoch advances in the same write that reports `Connected`, so a caller
/// pairing [`Connection::status`] with [`Connection::epoch`] never sees a stale
/// count, however fast the redial.
#[tokio::test]
async fn the_epoch_advances_on_reconnect() {
	let (port, mut sessions, _task) = spawn_server().await;
	let url: url::Url = format!("tcp://localhost:{port}/").parse().expect("parse url");
	let mut connection = quick_client(Default::default()).connect(url);

	let status = tokio::time::timeout(Duration::from_secs(10), connection.status())
		.await
		.expect("status timed out")
		.expect("status failed");
	assert_eq!(status, moq_tokio::Status::Connected);
	assert_eq!(connection.epoch(), 1, "the first connect is epoch 1");

	// Dropping the server's handle closes the session, so the loop redials.
	let session = sessions.recv().await.expect("server stopped accepting");
	drop(session);

	tokio::time::timeout(Duration::from_secs(10), async {
		while connection.epoch() < 2 {
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("the epoch never advanced past the first connect");
}

#[tokio::test]
async fn monitor_is_cloneable_without_keeping_the_connection_alive() {
	tokio::time::pause();
	let connection = quick_client(Default::default()).connect("tcp://127.0.0.1:1".parse::<url::Url>().unwrap());
	let monitor: moq_tokio::connection::Monitor = connection.monitor();
	let mut cloned = monitor.clone();
	let snapshot: Option<moq_tokio::connection::Snapshot> = cloned.snapshot();
	assert!(snapshot.is_none());
	assert!(monitor.stats().is_none());
	assert_eq!(monitor.presence(), moq_net::stats::Presence::default());

	drop(connection);
	assert!(matches!(
		cloned.presence_changed().await,
		Err(moq_tokio::Error::Stopped)
	));
	assert!(monitor.snapshot().is_none());
}

/// A stream-only moq server on a free loopback TCP port.
///
/// Returns the port, a receiver yielding every accepted session (so a test can
/// drain one), and the listener task. The free-port probe can lose a race with
/// another test between the probe closing and the real bind, so retry rather
/// than panicking in `listen`.
async fn spawn_server() -> (
	u16,
	tokio::sync::mpsc::UnboundedReceiver<moq_net::Session>,
	tokio::task::JoinHandle<()>,
) {
	for _ in 0..20 {
		let probe = TcpListener::bind("127.0.0.1:0").expect("bind probe");
		let port = probe.local_addr().expect("local addr").port();
		drop(probe);

		let Some((handle, sessions)) = listen_on(port).await else {
			continue;
		};

		return (port, sessions, handle);
	}
	panic!("could not bind a free TCP port after 20 attempts");
}

/// A stream-only moq server on `port`, or `None` when the port is taken.
///
/// Returns the listener task and a receiver yielding every accepted session, so a
/// test can drain one or hold it open. Separate from [`spawn_server`] so a test
/// can leave a port dark and only then bring a server up on it.
async fn listen_on(
	port: u16,
) -> Option<(
	tokio::task::JoinHandle<()>,
	tokio::sync::mpsc::UnboundedReceiver<moq_net::Session>,
)> {
	let mut config = moq_tokio::listen::Config::default();
	config.tcp.bind = Some(format!("127.0.0.1:{port}").parse().expect("parse addr"));
	let server = config.init(Default::default()).expect("init server");
	let mut server = server.listen().await.ok()?;

	let (accepted, sessions) = tokio::sync::mpsc::unbounded_channel();
	let handle = tokio::spawn(async move {
		while let Some(request) = server.accept().await {
			let origin = moq_tokio::origin::spawn();
			match request.with_publisher(&origin).ok().await {
				Ok(session) => {
					let _ = accepted.send(session);
				}
				Err(err) => tracing::warn!(%err, "accept failed"),
			}
		}
	});

	Some((handle, sessions))
}

/// A replacement drained on arrival does not cost the loop the session that is
/// still serving.
///
/// The regression it guards: a relay restarting kept accepting for its whole
/// drain window and waved each new session away at once. Parking one of those as
/// the predecessor retired the session still carrying our groups, which cut the
/// media 56ms into a 10s window that exists precisely to avoid that.
#[tokio::test]
async fn an_immediately_drained_replacement_keeps_the_serving_session() {
	let (port, mut sessions, _task) = spawn_server().await;
	let url: url::Url = format!("tcp://localhost:{port}/").parse().expect("parse url");
	let _connection = quick_client(Default::default()).connect(url);

	let first = tokio::time::timeout(Duration::from_secs(10), sessions.recv())
		.await
		.expect("first dial timed out")
		.expect("server stopped accepting");

	// Left up past the backoff floor, so the loop counts it healthy and parks it as
	// the predecessor rather than scoring its GOAWAY as a failure.
	tokio::time::sleep(Duration::from_millis(150)).await;
	first.drain().send(moq_net::goaway::Goaway::new()).expect("send goaway");

	// The replacement is waved away before it serves anything, the way a draining
	// relay used to answer a redial.
	let second = tokio::time::timeout(Duration::from_secs(10), sessions.recv())
		.await
		.expect("never redialed")
		.expect("server stopped accepting");
	second
		.drain()
		.send(moq_net::goaway::Goaway::new())
		.expect("send goaway");

	assert!(
		tokio::time::timeout(Duration::from_millis(500), first.closed())
			.await
			.is_err(),
		"the session still serving was retired for a replacement that never served"
	);
}

/// A peer that drains every session is given up on for the drain, not for a
/// redirect it never sent.
///
/// A GOAWAY with no URI says "reconnect to me", so naming it a redirect misreports
/// the one line an operator reads when a client gives up.
///
/// Time moves only when the test advances it, and only while the loop sleeps
/// between attempts. A budget that runs out mid-dial ends the loop on that dial's
/// timeout instead of the drain: a real clock allows that at random, and a paused
/// clock left to auto-advance forces it, jumping to the next deadline whenever the
/// runtime waits on a socket.
#[tokio::test(start_paused = true)]
async fn a_peer_draining_every_session_names_the_drain() {
	// A running blocking task holds auto-advance off, tokio's documented way. It
	// returns when the test ends and drops the sender.
	let (_release, hold) = std::sync::mpsc::channel::<()>();
	let _frozen = tokio::task::spawn_blocking(move || hold.recv());

	let (port, mut sessions, _task) = spawn_server().await;
	let url: url::Url = format!("tcp://localhost:{port}/").parse().expect("parse url");

	// Both at the 50ms floor, so no backoff wait is longer than `max`.
	let mut backoff = moq_tokio::Backoff::default();
	backoff.initial = Duration::from_millis(50);
	backoff.max = Duration::from_millis(50);
	backoff.timeout = Duration::from_millis(200);
	let (wait, budget) = (backoff.max, backoff.timeout);

	let started = tokio::time::Instant::now();
	let mut connection = client(backoff).connect(url);

	// Held, not dropped: a session dropped here would close before its GOAWAY
	// reached the wire, and the client would see a plain close.
	let mut held = Vec::new();
	let err = loop {
		let session = tokio::select! {
			closed = connection.closed() => break closed.expect_err("reconnect loop stopped without an error"),
			session = sessions.recv() => session.expect("server stopped accepting"),
		};
		assert!(
			started.elapsed() < budget,
			"dialed again after the {budget:?} budget ran out"
		);

		// Each step waits for the one before, so no status change can coalesce away.
		let status = connection.status().await.expect("reconnect loop stopped");
		assert_eq!(status, moq_tokio::Status::Connected);
		session
			.drain()
			.send(moq_net::goaway::Goaway::new())
			.expect("send goaway");
		let status = connection.status().await.expect("reconnect loop stopped");
		assert_eq!(status, moq_tokio::Status::Migrating);
		held.push(session);

		// Drained before it served, so the loop is asleep in its backoff.
		tokio::time::advance(wait).await;
	};

	let message = err.to_string();
	assert!(message.contains("peer is draining"), "gave up with {message}");
	assert!(
		!message.contains("redirected"),
		"gave up with {message}, calling a drain a redirect"
	);
}

/// A peer away for longer than a relay restart takes is still reconnected to, on
/// the default give-up window.
///
/// The default is what a native publisher runs on, and a graceful relay drains for
/// its own window (10s) before the process even exits, so a client that gave up
/// after 10s could not survive its own relay being restarted. Virtual time, so the
/// outage costs the suite nothing.
#[tokio::test(start_paused = true)]
async fn a_peer_away_longer_than_a_relay_restart_is_reconnected_to() {
	// Nothing has ever listened here, so every dial is refused until the server
	// binds, and the later bind cannot land on a socket in TIME_WAIT.
	let probe = TcpListener::bind("127.0.0.1:0").expect("bind probe");
	let port = probe.local_addr().expect("local addr").port();
	drop(probe);

	// The give-up window is the shipped default, which is the whole subject here.
	// The delays are shortened only so the dial the peer's return has to wait for is
	// a fifth of a second rather than five.
	let mut backoff = moq_tokio::Backoff::default();
	backoff.initial = Duration::from_millis(50);
	backoff.max = Duration::from_millis(200);

	let url: url::Url = format!("tcp://127.0.0.1:{port}/").parse().expect("parse url");
	let connection = client(backoff).connect(url);

	// Twice the window this default used to carry, and past a relay's drain plus the
	// time a process takes to come back. On the paused clock it costs nothing.
	tokio::time::sleep(Duration::from_secs(20)).await;

	// Still retrying. The budget is measured on this same clock, so an outage the
	// window covers cannot have ended the loop, however far any one dial got; the
	// window this default used to carry would have ended it 10s ago.
	assert!(
		tokio::time::timeout(Duration::ZERO, connection.closed()).await.is_err(),
		"the client gave up on a peer that was away for 20s"
	);

	// Back on the real clock before the peer returns, because the reconnect is real
	// socket work: a paused clock jumps to the next deadline whenever the runtime
	// waits on that socket, so a deadline across it would measure the jumps instead.
	tokio::time::resume();

	let (_task, mut sessions) = listen_on(port).await.expect("bind the port the client is dialing");
	tokio::time::timeout(Duration::from_secs(10), sessions.recv())
		.await
		.expect("the client never came back to a peer that returned")
		.expect("server stopped accepting");
}

/// A client that redials fast, so a refused redirect lands back on the original
/// server inside the test's patience.
fn quick_client(redirect: moq_tokio::Redirect) -> moq_tokio::Client {
	let mut config = moq_tokio::connect::Config::default();
	config.backoff.initial = Duration::from_millis(20);
	config.backoff.max = Duration::from_millis(40);
	config.backoff.timeout = Duration::ZERO;
	config.goaway.redirect = redirect;
	config.init(Default::default()).expect("failed to init client")
}

/// The default refuses peer-selected host changes and redials the configured URL.
#[tokio::test]
async fn a_redirect_to_another_host_is_refused_by_default() {
	let (port_a, mut sessions_a, _task_a) = spawn_server().await;
	let (port_b, mut sessions_b, _task_b) = spawn_server().await;

	let url: url::Url = format!("tcp://localhost:{port_a}/").parse().expect("parse url");
	let _connection = quick_client(Default::default()).connect(url);

	let first = tokio::time::timeout(Duration::from_secs(10), sessions_a.recv())
		.await
		.expect("first dial timed out")
		.expect("server A stopped accepting");

	first
		.drain()
		.send(moq_net::goaway::Goaway::redirect(format!("tcp://127.0.0.1:{port_b}/")))
		.expect("send goaway");

	// Refused, so the redial goes back to A rather than to the host the peer named.
	tokio::time::timeout(Duration::from_secs(10), sessions_a.recv())
		.await
		.expect("never redialed the configured URL")
		.expect("server A stopped accepting");

	assert!(
		sessions_b.try_recv().is_err(),
		"the peer moved us onto the host it named"
	);
}

/// `--goaway-redirect follow` is the opt-in that hands the peer the host, so the
/// same redirect is followed. Without this the default above would be
/// indistinguishable from ignoring the URI outright.
#[tokio::test]
async fn follow_still_honors_a_cross_host_redirect() {
	let (port_a, mut sessions_a, _task_a) = spawn_server().await;
	let (port_b, mut sessions_b, _task_b) = spawn_server().await;

	let url: url::Url = format!("tcp://localhost:{port_a}/").parse().expect("parse url");
	let _connection = quick_client(moq_tokio::Redirect::Follow).connect(url);

	let first = tokio::time::timeout(Duration::from_secs(10), sessions_a.recv())
		.await
		.expect("first dial timed out")
		.expect("server A stopped accepting");

	first
		.drain()
		.send(moq_net::goaway::Goaway::redirect(format!("tcp://127.0.0.1:{port_b}/")))
		.expect("send goaway");

	tokio::time::timeout(Duration::from_secs(10), sessions_b.recv())
		.await
		.expect("never followed the redirect")
		.expect("server B stopped accepting");
}

/// Refusing a peer-selected host must not discard caller-selected fallbacks.
#[tokio::test]
async fn a_refused_redirect_preserves_configured_fallbacks() {
	let (port_a, mut sessions_a, task_a) = spawn_server().await;
	let (port_b, mut sessions_b, _task_b) = spawn_server().await;
	let primary: url::Url = format!("tcp://localhost:{port_a}/").parse().expect("primary URL");
	let fallback: url::Url = format!("tcp://127.0.0.1:{port_b}/").parse().expect("fallback URL");
	let addrs = moq_tokio::connect::Addrs::new(primary).or(fallback);
	let _connection = quick_client(Default::default()).connect(addrs);
	let first = tokio::time::timeout(Duration::from_secs(10), sessions_a.recv())
		.await
		.expect("first dial timed out")
		.expect("server A stopped accepting");

	// Stop accepting before GOAWAY so reconnect must use the configured fallback.
	task_a.abort();
	assert!(task_a.await.expect_err("listener was aborted").is_cancelled());
	first
		.drain()
		.send(moq_net::goaway::Goaway::redirect("tcp://127.0.0.1:1/"))
		.expect("send goaway");

	tokio::time::timeout(Duration::from_secs(10), sessions_b.recv())
		.await
		.expect("configured fallback was discarded")
		.expect("server B stopped accepting");
}
