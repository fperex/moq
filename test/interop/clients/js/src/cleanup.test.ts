import { expect, test } from "bun:test";
import { closeBrowsers } from "./cleanup";

test("browser cleanup attempts every close before reporting a failure", async () => {
	const calls: string[] = [];
	const failure = new Error("close failed");
	const browsers = [
		{
			close: async () => {
				calls.push("first");
			},
		},
		{
			close: async () => {
				calls.push("second");
				throw failure;
			},
		},
		{
			close: async () => {
				calls.push("third");
			},
		},
	];

	let caught: unknown;
	try {
		await closeBrowsers(browsers);
	} catch (error) {
		caught = error;
	}

	expect(calls).toEqual(["first", "second", "third"]);
	expect(caught).toBe(failure);
});

test("browser cleanup resolves after every close succeeds", async () => {
	let closed = 0;
	await closeBrowsers([{ close: async () => void closed++ }, { close: async () => void closed++ }]);

	expect(closed).toBe(2);
});

test("browser cleanup preserves every failure after all closes", async () => {
	const calls: string[] = [];
	const first = new Error("first close failed");
	const second = new Error("second close failed");
	const browsers = [
		{
			close: async () => {
				calls.push("first");
				throw first;
			},
		},
		{
			close: async () => {
				calls.push("middle");
			},
		},
		{
			close: async () => {
				calls.push("last");
				throw second;
			},
		},
	];

	let caught: unknown;
	try {
		await closeBrowsers(browsers);
	} catch (error) {
		caught = error;
	}

	expect(calls).toEqual(["first", "middle", "last"]);
	expect(caught).toBeInstanceOf(AggregateError);
	expect((caught as AggregateError).errors).toEqual([first, second]);
});
