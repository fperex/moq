# Applied after E2: record every catalog audio/video change, not only the first.
import sys, pathlib
p = pathlib.Path(sys.argv[1]) / "demo/web/src/harness.ts"; s = p.read_text()
s = s.replace('''	let catalogSent = false;''', '''	let lastCatalog = "";''')
s = s.replace('''		if (!catalogSent) {
			const cat = el.catalog;
			if (cat?.audio) {
				o.catalogAudio = JSON.stringify(cat.audio).slice(0, 600);
				o.catalogVideo = JSON.stringify(cat.video).slice(0, 600);
				catalogSent = true;
			}
		}''', '''		const cat = el.catalog;
		const now = cat?.audio ? JSON.stringify(cat.audio) : "";
		if (now && now !== lastCatalog) {
			o.catalogAudio = now.slice(0, 600);
			o.catalogVideo = JSON.stringify(cat.video).slice(0, 600);
			push("catalog", { audio: now.slice(0, 600), video: JSON.stringify(cat.video).slice(0, 600) });
			lastCatalog = now;
		}''')
p.write_text(s); print("harness: catalog change tracking")
