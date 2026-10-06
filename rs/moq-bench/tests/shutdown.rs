#![cfg(feature = "noq")]

use std::process::Stdio;
use std::time::Duration;

use moq_net::{Error, SessionError};

#[tokio::test]
async fn duration_sends_close_before_process_exit() {
	moq_tokio::crypto::install_default().unwrap();
	let mut listen = moq_tokio::listen::Config::default();
	listen.bind = Some("127.0.0.1:0".parse().unwrap());
	listen.tls.generate = vec!["localhost".into()];
	let mut server = listen.init(Default::default()).unwrap().listen().await.unwrap();
	let url = format!("moqt://127.0.0.1:{}", server.local_addr().unwrap().port());

	// The child owns a separate runtime, so exiting before queued closes are sent is visible.
	let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_moq-bench"))
		.args([
			"--connect",
			&url,
			"--connect-tls-insecure",
			"--connect-tls-host-name",
			"localhost",
			"--connections",
			"8",
			"--broadcasts",
			"0",
			"--subscribe",
			"0",
			"--startup",
			"0s",
			"--duration",
			"1s",
		])
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true)
		.spawn()
		.unwrap();

	let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
	let sessions = tokio::time::timeout_at(deadline, async {
		let mut handshakes = tokio::task::JoinSet::new();
		for _ in 0..8 {
			let request = server.accept().await.expect("benchmark connection");
			handshakes.spawn(async move { request.ok().await.unwrap() });
		}
		let mut sessions = Vec::new();
		while let Some(session) = handshakes.join_next().await {
			sessions.push(session.unwrap());
		}
		sessions
	})
	.await
	.expect("benchmark did not connect all eight peers");
	let output = tokio::time::timeout_at(deadline, child.wait_with_output())
		.await
		.expect("benchmark did not exit")
		.unwrap();
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	for session in sessions {
		let closed = tokio::time::timeout_at(deadline, session.closed())
			.await
			.expect("benchmark peer never received close");
		// Code 0 decodes to `Cancel` whether the connection task dropped it first or the
		// endpoint closed it. An unsent close never arrives: the peer waits out its idle
		// timeout instead.
		assert!(matches!(&closed, Error::Session(SessionError::Cancel)), "{closed:?}");
	}
}
