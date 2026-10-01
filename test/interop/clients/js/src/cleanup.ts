type BrowserHandle = {
	close(): Promise<void>;
};

/** Close every browser and report teardown failures after all attempts. */
export async function closeBrowsers(browsers: readonly BrowserHandle[]): Promise<void> {
	const failures: unknown[] = [];
	for (const browser of browsers) {
		try {
			await browser.close();
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${failures.length} browsers failed to close`);
}
