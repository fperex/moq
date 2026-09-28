//! Native playout costs across channel counts and queued packets.

use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};

// Compile the implementation here to keep the DSP modules private.
#[path = "../src/playout/buffer.rs"]
#[allow(dead_code)]
mod buffer;
#[cfg(test)]
#[path = "../src/playout/fixture.rs"]
#[allow(dead_code)]
mod fixture;
#[path = "../src/playout/noise.rs"]
#[allow(dead_code, unused_imports)]
mod noise;

struct Counter;

static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: Counter = Counter;

unsafe impl GlobalAlloc for Counter {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
		unsafe { System.alloc(layout) }
	}

	unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
		ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
		unsafe { System.alloc_zeroed(layout) }
	}

	unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
		unsafe { System.realloc(ptr, layout, new_size) }
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		unsafe { System.dealloc(ptr, layout) }
	}
}

fn frames(rate: u32, duration: Duration) -> usize {
	(f64::from(rate) * duration.as_secs_f64()).round() as usize
}

fn noise_update(c: &mut Criterion) {
	let mut group = c.benchmark_group("playout_noise_channels");
	for channels in [1, 2, 6] {
		let mut seed = 42u32;
		let pcm: Vec<f32> = (0..960 * channels)
			.map(|_| {
				seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
				(seed as f32 / u32::MAX as f32 - 0.5) * 0.006
			})
			.collect();
		let mut estimate = noise::Noise::new(channels);
		estimate.update(&pcm);
		let allocations = ALLOCATIONS.load(Ordering::Relaxed);
		estimate.update(black_box(&pcm));
		assert_eq!(
			ALLOCATIONS.load(Ordering::Relaxed),
			allocations,
			"noise update allocated"
		);
		group.bench_function(BenchmarkId::from_parameter(channels), |b| {
			b.iter(|| {
				estimate.update(black_box(&pcm));
				black_box(estimate.energy(0));
			});
		});
	}
	group.finish();
}

fn buffered_after_hole(c: &mut Criterion) {
	let mut group = c.benchmark_group("playout_backlog_packets");
	for packets in [1, 10, 100, 1000] {
		let mut buffer = buffer::Buffer::new(48_000, 1);
		buffer.insert(Duration::ZERO, &[0.25; 168]);
		for i in 1..packets {
			buffer.insert(Duration::from_millis(i * 20), &[0.5; 960]);
		}
		let ready = buffer.ready();
		assert_eq!(buffer.has_after(ready), packets > 1);
		group.bench_function(BenchmarkId::from_parameter(packets), |b| {
			b.iter(|| black_box(black_box(&buffer).has_after(black_box(ready))));
		});
	}
	group.finish();
}

criterion_group!(benches, noise_update, buffered_after_hole);
criterion_main!(benches);
