import type { Time } from "@moq/net";
import type { Command, Init } from "./ingress";
import type { Stats } from "./playout";

/** The playout policy selected by the owner. */
export type Policy = Extract<Command, { kind: "target" }>;

/** Shared or transferred input for the audio worklet. */
export type Message =
	| { type: "init"; rate: number; channels: number; policy: Policy; shared?: Init }
	| { type: "command"; command: Command };

/** The media position rendered at an AudioContext frame. */
export interface State {
	type: "state";
	epoch: number;
	/** Cumulative per-channel PCM frames accepted, including earlier epochs. */
	acceptedFrames: number;
	frame: number;
	timestamp: Time.Micro | undefined;
	rate: number;
	stalled: boolean;
	stats: Stats;
}

/** Messages delivered from the worklet to its owner. */
export type ToMain = State | { type: "consumed"; frames: number } | { type: "error"; message: string };
