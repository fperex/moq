import { expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// The worker bundles everything its entry imports, and runs it where there is no document. This walks
// that graph the way a bundler does: every import that survives type erasure, from the entry through
// this package's own modules. Packages are not walked; none of them knows about the page.

const transpiler = new Bun.Transpiler({ loader: "ts" });
const SRC = resolve(import.meta.dir, "../..");

function file(path: string): string {
	for (const candidate of [path, `${path}.ts`, `${path}/index.ts`]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	throw new Error(`cannot resolve ${path}`);
}

/** Every module of this package the entry reaches, and every specifier on the way. */
function graph(entry: string): { modules: Map<string, string>; specifiers: Set<string> } {
	const modules = new Map<string, string>();
	const specifiers = new Set<string>();
	const visit = (path: string) => {
		const name = relative(SRC, path);
		if (modules.has(name)) return;
		const code = readFileSync(path, "utf8");
		modules.set(name, code);
		for (const { path: specifier } of transpiler.scanImports(code)) {
			specifiers.add(specifier);
			if (!specifier.startsWith(".")) continue;
			visit(file(resolve(dirname(path), specifier.split("?")[0])));
		}
	};
	visit(file(resolve(import.meta.dir, entry)));
	return { modules, specifiers };
}

it("the worker's import graph holds nothing only the page can run", () => {
	const { modules, specifiers } = graph("worker.ts");
	expect(modules.has("audio/worker/host.ts")).toBe(true);
	expect(modules.has("audio/supply.ts")).toBe(true);

	// The render worklet is compiled for the page by a Vite plugin, and belongs to the page's graph.
	expect([...specifiers].filter((specifier) => specifier.includes("?"))).toEqual([]);
	// The decoder builds the AudioContext; the worker may name its types, never its values.
	expect([...modules.keys()].filter((name) => name === "audio/decoder.ts")).toEqual([]);
	// libav is the page's polyfill. Named nowhere in the worker's code, a bundler leaves it out, and the
	// host's own test proves the worker never loads it.
	const libav = [...modules].filter(([, code]) => /\bLibav\b/.test(transpiler.transformSync(code)));
	expect(libav.map(([name]) => name)).toEqual([]);
});
