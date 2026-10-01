use std::{net::SocketAddr, sync::Arc, time::Duration};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use moq_shaper::{Config, Options, Profile, Setup, Shaper, Step};
use tokio::{net::UdpSocket, runtime::Runtime, task::JoinSet};

fn forward(c: &mut Criterion) {
	let runtime = Runtime::new().unwrap();
	let localhost: SocketAddr = "127.0.0.1:0".parse().unwrap();
	let mut group = c.benchmark_group("shaper_forward");
	for clients in [1, 10, 100] {
		for steps in [0, 4, 64] {
			let (shaper, sockets, echo_task) = runtime.block_on(async {
				let echo = UdpSocket::bind(localhost).await.unwrap();
				let target = echo.local_addr().unwrap();
				let echo_task = tokio::spawn(async move {
					let mut packet = [0; 64];
					loop {
						let (size, from) = echo.recv_from(&mut packet).await.unwrap();
						echo.send_to(&packet[..size], from).await.unwrap();
					}
				});
				let options = Options {
					steps: (0..steps)
						.map(|i| Step {
							at: Duration::from_secs(3600 + i),
							loss: Some(0.0),
							..Default::default()
						})
						.collect(),
					..Default::default()
				};
				let shaper = Shaper::bind(Setup {
					up: options.clone(),
					down: options,
					..Config {
						bind: localhost,
						target,
						seed: 1,
						up: Profile::default(),
						down: Profile::default(),
					}
					.into()
				})
				.await
				.unwrap();
				let mut sockets = Vec::new();
				for _ in 0..clients {
					let socket = UdpSocket::bind(localhost).await.unwrap();
					socket.connect(shaper.addr()).await.unwrap();
					sockets.push(Arc::new(socket));
				}
				(shaper, sockets, echo_task)
			});
			group.throughput(Throughput::Elements(clients * 32));
			group.bench_function(BenchmarkId::new(clients.to_string(), steps), |b| {
				b.iter(|| {
					runtime.block_on(async {
						tokio::time::timeout(Duration::from_secs(10), async {
							let mut tasks = JoinSet::new();
							for socket in &sockets {
								let socket = socket.clone();
								tasks.spawn(async move {
									let mut packet = [0; 64];
									for _ in 0..32 {
										socket.send(&[7; 64]).await.unwrap();
										assert_eq!(socket.recv(&mut packet).await.unwrap(), 64);
										assert_eq!(packet, [7; 64]);
									}
								});
							}
							while let Some(result) = tasks.join_next().await {
								result.unwrap();
							}
						})
						.await
						.expect("shaper round trips did not finish");
					})
				});
			});
			shaper.verify().unwrap();
			echo_task.abort();
		}
	}
}

criterion_group!(benches, forward);
criterion_main!(benches);
