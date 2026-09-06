// Drive enc-bench.html in a CDP Chrome and print the final report. bun enc-bench.mjs --cdp=9225 --query='mode=realtime&opus=voip&seconds=20'
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.match(/^--([^=]+)=(.*)$/)?.slice(1) ?? [a, true]));
const CDP = Number(args.cdp ?? 9225);
const VITE = Number(args.vite ?? 5174);
const url = `http://localhost:${VITE}/enc-bench.html?${args.query ?? "mode=realtime&seconds=20"}`;
const info = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const send = (method, params = {}) => new Promise((res) => { const myId = ++id; const h = (m) => { const msg = JSON.parse(m.data); if (msg.id === myId) { ws.removeEventListener("message", h); res(msg); } }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id: myId, method, params })); });
if (args.front) await send("Page.bringToFront");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last;
for (let i = 0; i < 120; i++) {
	await sleep(1000);
	const r = await send("Runtime.evaluate", { expression: "document.getElementById('info').textContent", returnByValue: true });
	last = r.result?.result?.value;
	if (last?.includes('"done":true')) break;
}
console.log(url, "\n", last);
await fetch(`http://127.0.0.1:${CDP}/json/close/${info.id}`);
ws.close();
