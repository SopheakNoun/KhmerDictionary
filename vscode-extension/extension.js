// Khmer Dictionary (Chuon Nath) — VS Code extension
// Provides: a search/browse webview panel, hover definitions over Khmer text,
// and a look-up command for the selected word. Data is a bundled JSON export
// of dict.sqlite (no native modules required).

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const cp = require("child_process");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- managed audio server (so the user needn't run a terminal) ----
let serverProc = null;
function serverReachable(timeoutMs) {
	return httpGetJson(audioBaseUrl() + "/health", timeoutMs || 800)
		.then(() => true).catch(() => false);
}
async function ensureServer(notify) {
	if (await serverReachable(800)) { return true; }              // already up (ours or theirs)
	const cfg = vscode.workspace.getConfiguration("khmerDictionary");
	const script = cfg.get("serverScriptPath");
	const py = cfg.get("pythonPath") || "python";
	if (!script || !fs.existsSync(script)) {
		if (notify) {
			vscode.window.showWarningMessage(
				"Khmer Dictionary: audio server isn't running and serverScriptPath is not set/found. " +
				"Set it in Settings, or start server.py yourself.");
		}
		return false;
	}
	if (!serverProc) {
		const port = (audioBaseUrl().match(/:(\d+)/) || [])[1] || "8777";
		let logFd = "ignore";
		try { logFd = fs.openSync(path.join(path.dirname(script), "server.log"), "a"); }
		catch (e) { /* unwritable folder: fall back to discarding output */ }
		serverProc = cp.spawn(silentPython(py), [script], {
			cwd: path.dirname(script),
			env: Object.assign({}, process.env, { PORT: port }),
			windowsHide: true,
			detached: process.platform === "win32",
			// Keep its output: "ignore" would send the log to nul, and under
			// pythonw.exe there is no console to fall back to.
			stdio: ["ignore", logFd, logFd],
		});
		if (serverProc.unref) { serverProc.unref(); }   // outlive this window
		serverProc.on("exit", () => { serverProc = null; });
		serverProc.on("error", () => { serverProc = null; });
	}
	for (let i = 0; i < 16; i++) {           // wait up to ~8s for it to come up
		await sleep(500);
		if (await serverReachable(800)) { return true; }
	}
	if (notify) { vscode.window.showErrorMessage("Khmer Dictionary: audio server did not start (check Python / serverScriptPath)."); }
	return false;
}
function stopServer() {
	if (serverProc) { try { serverProc.kill(); } catch (e) { /* ignore */ } serverProc = null; }
}

// pythonw.exe is Python without a console window, so starting the audio server
// never flashes a terminal. Falls back to whatever the user configured.
function silentPython(py) {
	if (process.platform !== "win32") { return py; }
	if (/pythonw(\.exe)?$/i.test(py)) { return py; }
	if (py.includes(path.sep) && /python(\.exe)?$/i.test(py)) {
		const w = py.replace(/python(\.exe)?$/i,
			m => (m.toLowerCase().endsWith(".exe") ? "pythonw.exe" : "pythonw"));
		return fs.existsSync(w) ? w : py;
	}
	return py === "python" ? "pythonw" : py;    // resolved from PATH
}

// Play a word through the OS (extension host) — used by the hover 🔊, which has
// no in-webview user gesture and would be blocked by the browser autoplay policy.
// Downloads the clip first (a local file plays far more reliably than a URL).
function playViaHost(word, voice) {
	const url = audioBaseUrl() + "/speak?voice=" + encodeURIComponent(voice || "sreymom") +
		"&word=" + encodeURIComponent(word);
	const tmp = path.join(require("os").tmpdir(), "kmdict_" + Date.now() + ".mp3");
	const lib = url.startsWith("https") ? https : http;
	lib.get(url, res => {
		if (res.statusCode !== 200) { res.resume(); vscode.window.showWarningMessage("Khmer Dictionary: no audio for this word."); return; }
		const file = fs.createWriteStream(tmp);
		res.pipe(file);
		file.on("finish", () => file.close(() => playFile(tmp)));
	}).on("error", e => vscode.window.showErrorMessage("Khmer Dictionary: audio fetch failed — " + e.message));
}
function playFile(tmp) {
	try {
		if (process.platform === "win32") {
			const ps = "Add-Type -AssemblyName presentationCore;" +
				"$p=New-Object System.Windows.Media.MediaPlayer;" +
				"$p.Open([uri]'" + tmp.replace(/'/g, "''") + "');$p.Play();Start-Sleep -Seconds 6";
			cp.spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
				{ windowsHide: true, stdio: "ignore" });
		} else {
			const bin = process.platform === "darwin" ? "afplay" : "ffplay";
			cp.spawn(bin, bin === "ffplay" ? ["-nodisp", "-autoexit", tmp] : [tmp], { stdio: "ignore" });
		}
	} catch (e) { vscode.window.showErrorMessage("Khmer Dictionary: could not play audio — " + e.message); }
}

// GET a URL and parse JSON, using Node's http module (no dependency on a global
// fetch, which older VS Code extension-host runtimes may lack).
function httpGetJson(url, timeoutMs) {
	return new Promise((resolve, reject) => {
		const lib = url.startsWith("https") ? https : http;
		const req = lib.get(url, { timeout: timeoutMs || 1500 }, res => {
			let data = "";
			res.on("data", c => { data += c; });
			res.on("end", () => {
				let j = null;
				try { j = JSON.parse(data); } catch (e) { /* not JSON */ }
				if (res.statusCode >= 400) { reject(new Error((j && j.error) || ("HTTP " + res.statusCode))); }
				else if (j) { resolve(j); }
				else { reject(new Error("bad response from the audio server")); }
			});
		});
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", reject);
	});
}

/** @type {{pron:Object<string,string>, entries:Object<string,Array<{pos:string,def:string,ex:string[]}>}}|null} */
let DICT = null;
let SORTED_WORDS = null; // for prefix matching in hover

const POS = {
	"ន": "នាម", "កិ": "កិរិយាសព្ទ", "គុ": "គុណនាម", "កិវិ": "កិរិយាវិសេសន៍",
	"និ": "និបាតសព្ទ", "ឧ": "ឧទានសព្ទ", "ប": "បុព្វបទ", "សព្វ": "សព្វនាម",
	"សំខ្យា": "សំខ្យា", "បសំ": "បច្ច័យសម្ព័ន្ធ", "អានិ": "អាការនិបាត", "បុ": "បុព្វបទ",
};
const posLabel = p => (p ? (POS[p] || p) : "");

function loadDict(context) {
	if (DICT) { return DICT; }
	const p = path.join(context.extensionPath, "data", "dict.json");
	DICT = JSON.parse(fs.readFileSync(p, "utf8"));
	return DICT;
}

function audioBaseUrl() {
	return (vscode.workspace.getConfiguration("khmerDictionary")
		.get("audioServerUrl") || "http://localhost:8777").replace(/\/$/, "");
}

// cached /health probe so the hover can decide whether to show a 🔊 link
let health = { sources: [], ts: 0 };
async function getAudioSources() {
	if (Date.now() - health.ts < 10000) { return health.sources; }
	try {
		const j = await httpGetJson(audioBaseUrl() + "/health", 1200);
		health = { sources: j.sources || [], ts: Date.now() };
	} catch (e) {
		health = { sources: [], ts: Date.now() };
	}
	return health.sources;
}

// Longest Khmer headword that matches at the start of `run`, else exact word.
function bestMatch(run) {
	if (DICT.entries[run]) { return run; }
	// try progressively shorter prefixes of the contiguous Khmer run
	for (let len = Math.min(run.length, 20); len >= 1; len--) {
		const cand = run.slice(0, len);
		if (DICT.entries[cand]) { return cand; }
	}
	return null;
}

const HOVER_VOICE = { sreymom: "♀", piseth: "♂", google: "G", kore: "G♀", puck: "G♂" };
const VOICE_TITLE = { sreymom: "Microsoft ស្រី", piseth: "Microsoft ប្រុស", google: "Google",
	kore: "Gemini ស្រី", puck: "Gemini ប្រុស" };

function markdownFor(word, sources) {
	const senses = DICT.entries[word];
	if (!senses) { return null; }
	sources = sources || [];
	const md = new vscode.MarkdownString();
	md.supportHtml = false;
	md.isTrusted = { enabledCommands: ["khmerdict.play", "khmerdict.open", "khmerdict.prev", "khmerdict.next"] };
	const pron = DICT.pron[word] ? ` _[${DICT.pron[word]}]_` : "";
	// one play link per available voice → click plays that voice directly
	const play = sources.length
		? " &nbsp;🔊 " + sources.map(v =>
			`[${HOVER_VOICE[v] || v}](command:khmerdict.play?${encodeURIComponent(JSON.stringify([word, v]))} "${VOICE_TITLE[v] || v}")`
		).join(" ")
		: "";
	// navigation: open this word in the panel, or step to the neighbouring headword
	const arg = w => encodeURIComponent(JSON.stringify([w]));
	const nav = ` &nbsp;|&nbsp; [📖](command:khmerdict.open?${arg(word)} "បើកក្នុងផ្ទាំង / Open in panel")`
		+ ` [◀](command:khmerdict.prev?${arg(word)} "ពាក្យមុន / Previous headword")`
		+ `[▶](command:khmerdict.next?${arg(word)} "ពាក្យបន្ទាប់ / Next headword")`;
	md.appendMarkdown(`### ${word}${pron}${play}${nav}\n\n`);
	const max = vscode.workspace.getConfiguration("khmerDictionary").get("hoverMaxSenses") || 0;
	const shown = (max > 0 && senses.length > max) ? senses.slice(0, max) : senses;
	shown.forEach((s, i) => {
		const pos = s.pos ? `_${posLabel(s.pos)}_ · ` : "";
		md.appendMarkdown(`**${i + 1}.** ${pos}${s.def}\n\n`);
		if (s.ex && s.ex.length) {
			md.appendMarkdown(`> ${s.ex.map(e => e).join("  \n> ")}\n\n`);
		}
	});
	if (shown.length < senses.length) {
		md.appendMarkdown(`_…+${senses.length - shown.length} more — open the panel_\n`);
	}
	return md;
}

// ---- hover ----
function makeHoverProvider(context) {
	return {
		async provideHover(document, position) {
			if (!vscode.workspace.getConfiguration("khmerDictionary").get("enableHover")) { return; }
			loadDict(context);
			// grab the contiguous Khmer run around the cursor
			const line = document.lineAt(position.line).text;
			const kh = /[ក-៿᧠-᧿]+/g;
			let m, run = null, start = 0;
			while ((m = kh.exec(line))) {
				if (m.index <= position.character && position.character <= m.index + m[0].length) {
					run = m[0]; start = m.index; break;
				}
			}
			if (!run) { return; }
			// text from cursor offset within the run (so prefix match is anchored near cursor)
			const offset = position.character - start;
			const fromCursor = run.slice(offset > 0 ? offset : 0);
			const word = bestMatch(run) || bestMatch(fromCursor);
			if (!word) { return; }
			const sources = await getAudioSources();
			const md = markdownFor(word, sources);
			return md ? new vscode.Hover(md) : undefined;
		}
	};
}

// ---- webview: an editor panel and a sidebar view, sharing one UI ----
let panel = null;
let panelReady = false;   // becomes true when a webview signals it has loaded
// "sidebar" = Activity Bar container, "panel" = the bottom Panel container.
const views = { sidebar: null, panel: null };
const viewReady = { sidebar: false, panel: false };
let pendingMsg = null;    // action to deliver on the next "ready" handshake

function activeWebview() {
	for (const slot of ["sidebar", "panel"]) {
		if (views[slot] && views[slot].visible) { return { wv: views[slot].webview, ready: viewReady[slot] }; }
	}
	if (panel) { return { wv: panel.webview, ready: panelReady }; }
	for (const slot of ["sidebar", "panel"]) {
		if (views[slot]) { return { wv: views[slot].webview, ready: viewReady[slot] }; }
	}
	return null;
}

function sendToPanel(msg) {
	const t = activeWebview();
	if (t && t.ready) { t.wv.postMessage(msg); }
	else { pendingMsg = msg; }
}

function reprobeAll() {
	if (panel && panelReady) { panel.webview.postMessage({ type: "reprobe" }); }
	for (const slot of ["sidebar", "panel"]) {
		if (views[slot] && viewReady[slot]) { views[slot].webview.postMessage({ type: "reprobe" }); }
	}
}

// Everything the webview needs, built once and reused by both hosts.
async function buildHtml(context, webview, host) {
	loadDict(context);
	const uri = p => webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, ...p)));
	const rawBase = (vscode.workspace.getConfiguration("khmerDictionary")
		.get("audioServerUrl") || "http://127.0.0.1:8777").replace(/\/$/, "");
	// asExternalUri is the correct way for a webview to reach a local server
	// (works locally and in Remote/Codespaces). On desktop it stays loopback.
	let audioBase = rawBase;
	try { audioBase = (await vscode.env.asExternalUri(vscode.Uri.parse(rawBase))).toString().replace(/\/$/, ""); }
	catch (e) { /* keep rawBase */ }
	const cfg = vscode.workspace.getConfiguration("khmerDictionary");
	const uiCfg = {
		defaultVoice: cfg.get("defaultVoice") || "sreymom",
		sttEngine: cfg.get("sttEngine") || "gemini",
		recordSeconds: cfg.get("recordSeconds") || 4,
		muteAudio: cfg.get("muteAudio") === true,
		panelTheme: cfg.get("panelTheme") || "auto",
		autoPlay: !!cfg.get("autoPlayOnLookup"),
		resultLimit: cfg.get("panelResultLimit") || 400,
		host: host || "editor",
	};
	return webviewHtml(webview, uri(["data", "dict.json"]),
		uri(["fonts", "KhmerOS_muollight.ttf"]), uri(["fonts", "KhmerOSSiemreap.ttf"]),
		audioBase, uiCfg);
}

function wireMessages(context, webview, onReady) {
	webview.onDidReceiveMessage(msg => {
		if (!msg) { return; }
		if (msg.type === "ready") {
			onReady();
			if (pendingMsg) { webview.postMessage(pendingMsg); pendingMsg = null; }
		} else if (msg.type === "openSettings") {
			vscode.commands.executeCommand("khmerdict.openSettings");
		} else if (msg.type === "dataError") {
			vscode.window.showErrorMessage("Khmer Dictionary: could not load dictionary data — " + msg.error);
		} else if (msg.type === "setConfig") {
			// the panel's 🔊 / ◐ toggles persist as user settings
			vscode.workspace.getConfiguration("khmerDictionary")
				.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
		} else if (msg.type === "startServer") {
			ensureServer(true).then(ok => { if (ok) { reprobeAll(); } });
		} else if (msg.type === "switchHost") {
			const to = msg.to || "sidebar";
			vscode.workspace.getConfiguration("khmerDictionary")
				.update("openIn", to, vscode.ConfigurationTarget.Global)
				.then(() => moveTo(context, to, msg.word));
		} else if (msg.type === "restartServer") {
			vscode.commands.executeCommand("khmerdict.restartServer");
		} else if (msg.type === "playHost") {
			// autoplay / editor-driven lookup: the webview may not play audio
			// itself without a click in it, so the host plays through the OS.
			if (!vscode.workspace.getConfiguration("khmerDictionary").get("muteAudio")) {
				playViaHost(msg.word, msg.voice);
			}
		}
	}, null, context.subscriptions);
}

function maybeAutoStartServer() {
	if (vscode.workspace.getConfiguration("khmerDictionary").get("autoStartServer")) {
		ensureServer(false).then(ok => { if (ok) { reprobeAll(); } });
	}
}

// The Activity Bar view. VS Code resolves it the first time the user opens the
// container, and keeps it alive afterwards (retainContextWhenHidden).
class KhmerDictViewProvider {
	constructor(context, slot) { this.context = context; this.slot = slot; }
	async resolveWebviewView(view) {
		const slot = this.slot;
		views[slot] = view; viewReady[slot] = false;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(this.context.extensionPath)],
		};
		view.webview.html = await buildHtml(this.context, view.webview, slot);
		wireMessages(this.context, view.webview, () => { viewReady[slot] = true; });
		view.onDidDispose(() => { views[slot] = null; viewReady[slot] = false; });
		maybeAutoStartServer();
	}
}

const VIEW_ID = { sidebar: "khmerdict.view", panel: "khmerdict.panelView" };

// Move the dictionary between the sidebar view and an editor tab, carrying the
// word currently open across with it.
async function moveTo(context, to, word) {
	if (to === "editor") {
		await openPanel(context, word, { forceEditor: true });
		return;
	}
	if (panel) { panel.dispose(); }
	await vscode.commands.executeCommand(VIEW_ID[to] + ".focus");
	if (word) { sendToPanel({ type: "lookup", word: word }); }
}

// Show the dictionary where the user prefers it, and look a word up there.
async function openPanel(context, initialWord, opts) {
	opts = opts || {};
	loadDict(context);
	const where = opts.forceEditor ? "editor"
		: (vscode.workspace.getConfiguration("khmerDictionary").get("openIn") || "sidebar");

	if (where === "sidebar" || where === "panel") {
		try {
			await vscode.commands.executeCommand(VIEW_ID[where] + ".focus");
			maybeAutoStartServer();
			if (initialWord) { sendToPanel({ type: opts.play ? "play" : "lookup", word: initialWord, voice: opts.voice }); }
			return;
		} catch (e) { /* fall through to the editor panel */ }
	}

	if (panel) {
		panel.reveal(vscode.ViewColumn.Beside, !!opts.preserveFocus);
	} else {
		panelReady = false;
		panel = vscode.window.createWebviewPanel(
			"khmerDictionary", "Khmer Dictionary",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: !!opts.preserveFocus },
			{ enableScripts: true, retainContextWhenHidden: true,
			  localResourceRoots: [vscode.Uri.file(context.extensionPath)] }
		);
		panel.onDidDispose(() => { panel = null; panelReady = false; pendingMsg = null; }, null, context.subscriptions);
		panel.webview.html = await buildHtml(context, panel.webview, "editor");
		wireMessages(context, panel.webview, () => { panelReady = true; });
	}
	maybeAutoStartServer();
	if (initialWord) {
		sendToPanel({ type: opts.play ? "play" : "lookup", word: initialWord, voice: opts.voice });
	}
}

// Step to the neighbouring headword in dictionary order and open it there.
function stepWord(context, word, delta) {
	if (!DICT) { loadDict(context); }
	if (!SORTED_WORDS) { SORTED_WORDS = Object.keys(DICT.entries).sort((a, b) => a.localeCompare(b)); }
	const i = SORTED_WORDS.indexOf(word);
	if (i < 0) { openPanel(context, word); return; }
	const j = Math.min(SORTED_WORDS.length - 1, Math.max(0, i + delta));
	openPanel(context, SORTED_WORDS[j]);
}

function selectedOrPrompt(context) {
	const ed = vscode.window.activeTextEditor;
	let sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection).trim() : "";
	if (sel) { openPanel(context, sel); return; }
	vscode.window.showInputBox({ prompt: "ស្វែងរកពាក្យ / Search a Khmer word" }).then(v => {
		if (v) { openPanel(context, v.trim()); }
	});
}

function webviewHtml(webview, dataUri, fontMuol, fontBody, audioBase, cfg) {
	// allow the audio server origin (both the localhost and 127.0.0.1 spellings,
	// whichever way the setting is written) for fetch + <audio>
	const audioOrigins = [audioBase,
		audioBase.replace("localhost", "127.0.0.1"),
		audioBase.replace("127.0.0.1", "localhost")]
		.filter((v, i, a) => a.indexOf(v) === i).join(" ");
	const csp = `default-src 'none'; img-src ${webview.cspSource}; ` +
		`font-src ${webview.cspSource}; style-src 'unsafe-inline'; ` +
		`script-src 'unsafe-inline'; ` +
		`connect-src ${webview.cspSource} ${audioOrigins}; ` +
		// blob: matters — playback fetches the clip and plays it from a blob URL,
		// so without it every sound is silently blocked by the CSP.
		`media-src ${webview.cspSource} ${audioOrigins} blob:;`;
	return `<!DOCTYPE html><html lang="km"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
@font-face{font-family:"KhmerMuol";src:url("${fontMuol}") format("truetype")}
@font-face{font-family:"KhmerSiemreap";src:url("${fontBody}") format("truetype")}
:root{--acc:#8a1f1f;--btn:#8a1f1f;--gold:#b8892b}
body.vscode-dark{--acc:#f0908a;--btn:#c0392b;--gold:#d9b25a}
body.vscode-high-contrast{--acc:#ff9a9a;--btn:#d9342f;--gold:#e8c34a}
*{box-sizing:border-box}
body{margin:0;font-family:"KhmerSiemreap","Noto Sans Khmer",sans-serif;
  color:var(--vscode-foreground);background:var(--vscode-editor-background);line-height:1.7}
.top{position:sticky;top:0;background:var(--vscode-editor-background);padding:10px;
  border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:8px}
#q{flex:1;padding:8px 10px;font-size:16px;font-family:inherit;
  color:var(--vscode-input-foreground);background:var(--vscode-input-background);
  border:1px solid var(--vscode-input-border,transparent);border-radius:6px;outline:none}
.wrap{display:grid;grid-template-columns:230px 1fr;gap:0;height:calc(100vh - 55px)}
.list{overflow:auto;border-right:1px solid var(--vscode-panel-border)}
.list div{padding:8px 12px;cursor:pointer;font-size:17px;border-bottom:1px solid var(--vscode-panel-border)}
.list div:hover,.list div.on{background:var(--vscode-list-hoverBackground)}
.detail{overflow:auto;padding:18px}
.hw{font-family:"KhmerMuol";font-size:30px;color:var(--acc)}
.sub{opacity:.7;font-size:13px;margin-bottom:14px}
.sense{padding:12px 0;border-top:1px solid var(--vscode-panel-border)}
.pos{display:inline-block;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
  padding:1px 8px;border-radius:10px;font-size:12px;margin-bottom:4px}
.def{font-size:17px}
.ex{margin-top:8px;padding:8px 12px;border-left:3px solid var(--gold);
  background:var(--vscode-textBlockQuote-background);border-radius:4px;font-size:15px}
.alpha{display:flex;flex-wrap:wrap;gap:4px;padding:8px;border-bottom:1px solid var(--vscode-panel-border)}
.alpha button{font-family:"KhmerSiemreap";font-size:16px;min-width:32px;height:32px;cursor:pointer;
  background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);
  border:0;border-radius:5px}
.empty{opacity:.6;padding:40px;text-align:center}
.hwrow{display:flex;align-items:center;gap:10px}
.speak{border:0;background:var(--btn);color:#fff;width:38px;height:38px;border-radius:50%;
  cursor:pointer;font-size:17px;flex:none}
.speak:hover{filter:brightness(1.1)}
.speak.playing{animation:pulse 1s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
#sttsel{font-family:inherit;font-size:13px;padding:6px;border-radius:6px;
  color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);
  border:1px solid var(--vscode-dropdown-border,transparent)}
#voice{font-family:inherit;font-size:13px;padding:6px;border-radius:6px;
  color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);
  border:1px solid var(--vscode-dropdown-border,transparent)}
#mic{flex:none;cursor:pointer;font-size:15px;width:34px;border-radius:6px;
  color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:0}
#mic:hover{filter:brightness(1.1)}
#mic:disabled,#voice:disabled,#sttsel:disabled{opacity:.45;cursor:default}
#mic.rec{background:var(--btn);color:#fff;animation:pulse 1s ease-in-out infinite}
#gear,#sound,#theme,#back,#fwd,#restart,#where{flex:none;cursor:pointer;font-size:15px;width:34px;border-radius:6px;
  color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:0}
#gear:hover,#sound:hover,#theme:hover,#back:hover,#fwd:hover,#restart:hover,#where:hover{filter:brightness(1.1)}
#back:disabled,#fwd:disabled{opacity:.35;cursor:default}
#sound.off{opacity:.55}
/* Forced themes: the panel normally inherits VS Code's colours, so overriding
   the --vscode-* tokens at body level re-skins everything in one place. */
body[data-force="light"]{
  --vscode-foreground:#2b2620; --vscode-editor-background:#f4f1ea;
  --vscode-panel-border:#e2ddd2; --vscode-input-foreground:#2b2620;
  --vscode-input-background:#fff; --vscode-input-border:#e2ddd2;
  --vscode-list-hoverBackground:#f3e4e4; --vscode-badge-background:#f3e4e4;
  --vscode-badge-foreground:#8a1f1f; --vscode-textBlockQuote-background:#efeade;
  --vscode-button-secondaryBackground:#e6e0d3; --vscode-button-secondaryForeground:#2b2620;
  --vscode-dropdown-background:#fff; --vscode-dropdown-foreground:#2b2620;
  --vscode-dropdown-border:#e2ddd2; --vscode-textLink-foreground:#8a1f1f;
  --acc:#8a1f1f; --btn:#8a1f1f; --gold:#b8892b;
}
body[data-force="dark"]{
  --vscode-foreground:#ece5d8; --vscode-editor-background:#17140f;
  --vscode-panel-border:#332d23; --vscode-input-foreground:#ece5d8;
  --vscode-input-background:#211d16; --vscode-input-border:#332d23;
  --vscode-list-hoverBackground:#2a1c1c; --vscode-badge-background:#2a1c1c;
  --vscode-badge-foreground:#e07a7a; --vscode-textBlockQuote-background:#211d16;
  --vscode-button-secondaryBackground:#2a2419; --vscode-button-secondaryForeground:#ece5d8;
  --vscode-dropdown-background:#211d16; --vscode-dropdown-foreground:#ece5d8;
  --vscode-dropdown-border:#332d23; --vscode-textLink-foreground:#e07a7a;
  --acc:#e07a7a; --btn:#c0392b; --gold:#d9b25a;
}
#status{display:none;padding:8px 12px;font-size:13px;
  background:var(--vscode-inputValidation-warningBackground,#5a4a12);
  color:var(--vscode-foreground);border-bottom:1px solid var(--vscode-panel-border)}
#status a{color:var(--vscode-textLink-foreground)}
</style></head><body>
<div class="top"><input id="q" placeholder="ស្វែងរកពាក្យ…" autocomplete="off">
  <button id="mic" title="ស្វែងរកដោយសំឡេង / Voice search">🎤</button>
  <select id="sttsel" title="ម៉ាស៊ីនស្ដាប់ / Speech-to-text engine"></select>
  <button id="back" title="ថយក្រោយ / Back (Alt+Left)" disabled>◀</button>
  <button id="fwd" title="ទៅមុខ / Forward (Alt+Right)" disabled>▶</button>
  <button id="sound" title="បិទ/បើកសំឡេង / Sound on-off">🔊</button>
  <button id="restart" title="ចាប់ផ្ដើម server ឡើងវិញ / Restart audio service">⟳</button>
  <button id="where" title="ប្ដូរទីតាំង / Move to editor or sidebar">⧉</button>
  <button id="theme" title="ពន្លឺ/ងងឹត / Light-dark">◐</button>
  <select id="voice" title="សំឡេង / Voice"></select>
  <button id="gear" title="Settings">⚙</button></div>
<div id="status"></div>
<div class="alpha" id="alpha"></div>
<div class="wrap"><div class="list" id="list"></div><div class="detail" id="detail">
  <div class="empty">ជ្រើសរើសពាក្យ ឬវាយបញ្ចូលដើម្បីស្វែងរក។</div></div></div>
<script>
const AUDIO=${JSON.stringify(audioBase)};
const CFG=${JSON.stringify(cfg)};
const vsc=acquireVsCodeApi();
const VOICE_META={sreymom:"Microsoft ស្រី",piseth:"Microsoft ប្រុស",google:"Google",kore:"Gemini ស្រី",puck:"Gemini ប្រុស"};
let audioSources=[], voice=null, curAudio=null, curWord=null;
let sttSources=[], stt=null, hostMic=false;   // STT engines + host-side recording
const STT_META={whisper:"Whisper (local)",gemini:"Gemini",azure:"Microsoft Azure",google:"Google Cloud"};
document.getElementById("gear").onclick=()=>vsc.postMessage({type:"openSettings"});

// ---- sound on/off and panel theme (both remembered in settings) ----
let muted = !!CFG.muteAudio;
let panelTheme = CFG.panelTheme || "auto";      // auto | light | dark
const THEME_ICON={auto:"◐",light:"☀",dark:"☾"};
function applyTheme(){
  if(panelTheme==="auto") document.body.removeAttribute("data-force");
  else document.body.setAttribute("data-force",panelTheme);
  const b=document.getElementById("theme");
  b.textContent=THEME_ICON[panelTheme];
  b.title="រូបរាង៖ "+panelTheme+" (auto / light / dark)";
}
function applySound(){
  const b=document.getElementById("sound");
  b.textContent = muted ? "🔇" : "🔊";
  b.classList.toggle("off",muted);
  b.title = muted ? "សំឡេងបិទ / Sound off" : "សំឡេងបើក / Sound on";
  if(muted && curAudio){ curAudio.pause(); curAudio=null;
    document.querySelectorAll(".speak").forEach(x=>x.classList.remove("playing")); }
}
(function(){
  // one button, three homes: sidebar -> bottom panel -> editor tab -> sidebar
  const NEXT={sidebar:"panel", panel:"editor", editor:"sidebar"};
  const ICON={sidebar:"◧", panel:"▤", editor:"⧉"};
  const NAME={sidebar:"sidebar", panel:"bottom panel", editor:"editor tab"};
  const b=document.getElementById("where");
  const to=NEXT[CFG.host]||"sidebar";
  b.textContent=ICON[to];
  b.title="ប្ដូរទៅ "+NAME[to]+" / Move to the "+NAME[to];
  b.onclick=()=>vsc.postMessage({type:"switchHost", to:to, word:curWord});
})();
document.getElementById("restart").onclick=()=>{
  setStatus("កំពុងចាប់ផ្ដើម server ឡើងវិញ… / restarting the audio service…");
  vsc.postMessage({type:"restartServer"});
};
document.getElementById("sound").onclick=()=>{
  muted=!muted; applySound(); vsc.postMessage({type:"setConfig",key:"muteAudio",value:muted});
};
document.getElementById("theme").onclick=()=>{
  const order=["auto","light","dark"];
  panelTheme=order[(order.indexOf(panelTheme)+1)%order.length];
  applyTheme(); vsc.postMessage({type:"setConfig",key:"panelTheme",value:panelTheme});
};
const POS=${JSON.stringify(POS)};
const posLabel=p=>p?(POS[p]||p):"";
const CONS=["ក","ខ","គ","ឃ","ង","ច","ឆ","ជ","ឈ","ញ","ដ","ឋ","ឌ","ឍ","ណ","ត","ថ","ទ","ធ","ន","ប","ផ","ព","ភ","ម","យ","រ","ល","វ","ស","ហ","ឡ","អ"];
let DICT=null, WORDS=[];
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
$("#detail").innerHTML='<div class="empty">កំពុងផ្ទុកវចនានុក្រម… (loading)</div>';
fetch("${dataUri}").then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.json();})
  .then(d=>{DICT=d;WORDS=Object.keys(d.entries).sort();buildAlpha();browse("ក");
    $("#detail").innerHTML='<div class="empty">ជ្រើសរើសពាក្យ ឬវាយបញ្ចូល។</div>';})
  .catch(err=>{$("#detail").innerHTML='<div class="empty">⚠ ផ្ទុកទិន្នន័យមិនបាន (failed to load dictionary data):<br>'+esc(err&&err.message||err)+'</div>';
    try{vsc.postMessage({type:"dataError",error:String(err&&err.message||err)});}catch(e){}});
function buildAlpha(){const a=$("#alpha");CONS.forEach(c=>{const b=document.createElement("button");b.textContent=c;b.onclick=()=>browse(c);a.appendChild(b);});}
function browse(letter){const ws=WORDS.filter(w=>w.startsWith(letter)).slice(0,CFG.resultLimit);renderList(ws);}
function search(t){t=t.trim();if(!t){browse("ក");return;}
  const ws=WORDS.filter(w=>w.includes(t)).sort((a,b)=>{
    const ra=a===t?0:a.startsWith(t)?1:2, rb=b===t?0:b.startsWith(t)?1:2;
    return ra-rb || a.localeCompare(b);}).slice(0,CFG.resultLimit);
  renderList(ws);}
function renderList(ws){const l=$("#list");l.innerHTML="";
  if(!ws.length){l.innerHTML='<div style="cursor:default;opacity:.6">រកមិនឃើញ</div>';return;}
  ws.forEach(w=>{const d=document.createElement("div");d.textContent=w;d.onclick=()=>{show(w,d);};l.appendChild(d);});}
const hist=[]; let histAt=-1, histLock=false;
function updateNav(){ $("#back").disabled = histAt<=0; $("#fwd").disabled = histAt<0 || histAt>=hist.length-1; }
function goHist(d){ const j=histAt+d; if(j<0||j>=hist.length) return;
  histAt=j; histLock=true; show(hist[j],null); histLock=false; updateNav();
  const row=[...document.querySelectorAll(".list div")].find(x=>x.textContent===hist[j]);
  if(row){ document.querySelectorAll(".list div").forEach(x=>x.classList.remove("on"));
           row.classList.add("on"); row.scrollIntoView({block:"nearest"}); } }
$("#back").onclick=()=>goHist(-1);
$("#fwd").onclick=()=>goHist(1);
document.addEventListener("keydown",e=>{
  if(e.altKey&&e.key==="ArrowLeft"){e.preventDefault();goHist(-1);}
  else if(e.altKey&&e.key==="ArrowRight"){e.preventDefault();goHist(1);} });
function show(word,el){document.querySelectorAll(".list div").forEach(x=>x.classList.remove("on"));if(el)el.classList.add("on");
  const senses=DICT.entries[word];if(!senses){$("#detail").innerHTML='<div class="empty">រកមិនឃើញ</div>';return;}
  curWord=word;
  if(!histLock && hist[histAt]!==word){ hist.splice(histAt+1); hist.push(word); histAt=hist.length-1; updateNav(); }
  const pron=DICT.pron[word]?"["+esc(DICT.pron[word])+"] · ":"";
  const spk=audioSources.length?'<button class="speak" id="spk" title="ស្ដាប់">🔊</button>':'';
  let h='<div class="hwrow"><div class="hw">'+esc(word)+'</div>'+spk+'</div>'+
    '<div class="sub">'+pron+senses.length+' និយមន័យ</div>';
  senses.forEach((s,i)=>{h+='<div class="sense">'+(s.pos?'<div class="pos">'+esc(posLabel(s.pos))+'</div>':'')+
    '<div class="def">'+(i+1)+'. '+esc(s.def)+'</div>'+
    (s.ex&&s.ex.length?'<div class="ex">'+s.ex.map(e=>esc(e)).join('<br>')+'</div>':'')+'</div>';});
  $("#detail").innerHTML=h;
  const sb=$("#spk"); if(sb) sb.onclick=()=>play(word,sb);
  if(CFG.autoPlay && audioSources.length){ play(word,sb); }}
// ---- audio via local server (server.py) ----
function setStatus(html){const el=$("#status");if(html){el.style.display="";el.innerHTML=html;
  const rt=$("#retry");if(rt)rt.onclick=e=>{e.preventDefault();applyTheme(); applySound(); renderVoiceControls();
probeHealth();};
  const ss=$("#startsrv");if(ss)ss.onclick=e=>{e.preventDefault();setStatus("កំពុងចាប់ផ្ដើម server សំឡេង…");vsc.postMessage({type:"startServer"});};
  }else{el.style.display="none";el.innerHTML="";}}
// The voice switch and 🎤 stay in the toolbar at all times — disabled and
// explained when the server is down or a key is missing, rather than vanishing.
function renderVoiceControls(){
  const sel=$("#voice"), ss=$("#sttsel"), mic=$("#mic");
  sel.style.display=""; ss.style.display=""; mic.style.display="";

  sel.disabled = !audioSources.length;
  sel.innerHTML = audioSources.length
    ? audioSources.map(v=>'<option value="'+v+'">'+(VOICE_META[v]||v)+'</option>').join("")
    : '<option>សំឡេង — server បិទ</option>';
  if(voice && audioSources.includes(voice)) sel.value=voice;
  sel.title = audioSources.length ? "សំឡេង / Voice" : "server សំឡេងមិនដំណើរការ / audio server is not running";
  sel.onchange=()=>{voice=sel.value; if(curWord) play(curWord,$("#spk"));};

  ss.disabled = !stt;
  ss.innerHTML = Object.keys(STT_META).map(e=>{
    const have=sttSources.includes(e);
    return '<option value="'+e+'"'+(have?"":" disabled")+'>'+STT_META[e]+(have?"":" — no key")+'</option>';
  }).join("");
  if(stt) ss.value=stt;
  ss.onchange=()=>{ stt=ss.value; };

  mic.disabled = !stt;
  mic.title = stt ? ("ស្វែងរកដោយសំឡេង / Voice search ("+(STT_META[stt]||stt)+")")
    : (audioSources.length ? "គ្មានកូនសោ STT / no speech-to-text key — see API_ACCESS.md"
                           : "server សំឡេងមិនដំណើរការ / audio server is not running");
}

function probeHealth(){
  setStatus("កំពុងភ្ជាប់ server សំឡេង…");
  fetch(AUDIO+"/health",{cache:"no-store"}).then(r=>r.json()).then(j=>{
    audioSources=j.sources||[];
    sttSources=j.stt||[];
    hostMic=!!j.mic;
    stt=sttSources.includes(CFG.sttEngine)?CFG.sttEngine:(sttSources[0]||null);
    voice=audioSources.includes(CFG.defaultVoice)?CFG.defaultVoice
        :(audioSources.includes("sreymom")?"sreymom":audioSources[0]||null);
    renderVoiceControls();
    if(!audioSources.length){setStatus("⚠ server សំឡេងគ្មានសំឡេង (no voices).");return;}
    setStatus(null);
    if(curWord) show(curWord,null);   // re-render to reveal 🔊 if a word is already open
  }).catch(()=>{
    audioSources=[]; sttSources=[]; stt=null; voice=null;
    renderVoiceControls();
    setStatus("⚠ server សំឡេងមិនទាន់ដំណើរការ។ "+
      "<a href='#' id='startsrv'>▶ ចាប់ផ្ដើម server</a> &nbsp;|&nbsp; "+
      "<a href='#' id='retry'>ព្យាយាមម្ដងទៀត</a>");
  });
}
probeHealth();
async function play(word,btn,viaVoice){
  if(!audioSources.length) return;
  if(muted){ setStatus("🔇 សំឡេងបិទ (sound is off — click 🔇 to turn it back on)"); return; }
  if(curAudio){curAudio.pause();curAudio=null;}
  document.querySelectorAll(".speak").forEach(b=>b.classList.remove("playing"));
  const use=viaVoice||voice;
  const url=AUDIO+"/speak?voice="+encodeURIComponent(use)+"&word="+encodeURIComponent(word);
  // Online: stream straight from the server, which caches the clip in
  // audio.sqlite as it serves it. Offline or on error: fetch it instead, so the
  // reason can be read out of the response.
  if(navigator.onLine){
    const a=new Audio(url); curAudio=a;
    if(btn){btn.classList.add("playing"); a.onended=()=>btn.classList.remove("playing");}
    a.onerror=()=>{ if(btn)btn.classList.remove("playing"); playBlob(word,btn,use); };
    a.play().catch(()=>{ if(btn)btn.classList.remove("playing");
      vsc.postMessage({type:"playHost", word:word, voice:use}); });   // no gesture: let the host play it
    return;
  }
  return playBlob(word,btn,use);
}

async function playBlob(word,btn,use){
  let url;
  try{
    const r=await fetch(AUDIO+"/speak?voice="+encodeURIComponent(use)+"&word="+encodeURIComponent(word));
    if(!r.ok){
      let why=""; try{ why=(await r.json()).error||""; }catch(e){}
      const short=/429|RESOURCE_EXHAUSTED|quota/i.test(why)
        ? (use==="google"?"Google rate-limited":"Gemini out of quota")
        : (why||("HTTP "+r.status)).slice(0,90);
      const alt=audioSources.find(v=>v==="sreymom"||v==="piseth");
      if(alt&&alt!==use){
        setStatus("⚠ "+(VOICE_META[use]||use)+"៖ "+short+" — ប្រើ "+(VOICE_META[alt]||alt)+" ជំនួស។");
        return playBlob(word,btn,alt);
      }
      setStatus("⚠ សំឡេង៖ "+short); return;
    }
    url=URL.createObjectURL(await r.blob());
  }catch(e){ setStatus("⚠ សំឡេង៖ "+e.message); return; }
  const a=new Audio(url); curAudio=a;
  if(btn){btn.classList.add("playing");
    a.onended=a.onerror=()=>{btn.classList.remove("playing");URL.revokeObjectURL(url);};}
  a.play().catch(()=>{ if(btn)btn.classList.remove("playing");
    URL.revokeObjectURL(url);
    vsc.postMessage({type:"playHost", word:word, voice:use}); });
}
$("#q").addEventListener("input",e=>search(e.target.value));
vsc.postMessage({type:"ready"});   // tell the extension the webview is loaded (deliver queued action)
window.addEventListener("message",e=>{const d=e.data||{};
  if(d.type==="lookup"){const w=d.word;$("#q").value=w;
    if(!DICT){setTimeout(()=>runLookup(w),300);}else runLookup(w);}
  else if(d.type==="play"){playMsg(d.word,d.voice,0);}
  else if(d.type==="reprobe"){probeHealth();}
  else if(d.type==="record"){const m=$("#mic"); if(m && m.style.display!=="none") m.click();
    else setStatus("⚠ គ្មានម៉ាស៊ីនស្ដាប់ (no speech-to-text key — see API_ACCESS.md).");}});
function playMsg(w,v,tries){
  if(!DICT||!audioSources.length){ if(tries<12){setTimeout(()=>playMsg(w,v,tries+1),300);return;} }
  if(!DICT) return;
  if(v&&audioSources.includes(v)){ voice=v; const sel=$("#voice"); if(sel) sel.value=v; }
  $("#q").value=w; runLookup(w);
  const word=DICT.entries[w]?w:(WORDS.filter(x=>x.includes(w))[0]);
  if(word&&audioSources.length) play(word,$("#spk"));
}
function runLookup(w){ if(!DICT) return;
  if(DICT.entries[w]){ show(w,null); renderList(WORDS.filter(x=>x.includes(w)).slice(0,CFG.resultLimit)); }
  else { search(w); const first=WORDS.filter(x=>x.includes(w))[0]; if(first) show(first,null); } }
</script></body></html>`;
}

function activate(context) {
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("khmerdict.view",
			new KhmerDictViewProvider(context, "sidebar"),
			{ webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerWebviewViewProvider("khmerdict.panelView",
			new KhmerDictViewProvider(context, "panel"),
			{ webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand("khmerdict.openSidebar", () =>
			vscode.commands.executeCommand("khmerdict.view.focus")),
		vscode.commands.registerCommand("khmerdict.openBottomPanel", () =>
			vscode.commands.executeCommand("khmerdict.panelView.focus")),
		vscode.commands.registerCommand("khmerdict.open", word =>
			openPanel(context, typeof word === "string" ? word : undefined)),
		vscode.commands.registerCommand("khmerdict.prev", word => stepWord(context, word, -1)),
		vscode.commands.registerCommand("khmerdict.next", word => stepWord(context, word, +1)),
		vscode.commands.registerCommand("khmerdict.lookup", () => selectedOrPrompt(context)),
		vscode.commands.registerCommand("khmerdict.play", async (word, voice) => {
			if (vscode.workspace.getConfiguration("khmerDictionary").get("muteAudio")) {
				vscode.window.showInformationMessage(
					"Khmer Dictionary: sound is off — turn it back on with 🔇 in the panel.");
				return;
			}
			if (!word) { return; }
			if (!(await ensureServer(true))) { return; }
			playViaHost(word, voice);   // OS playback — hover has no webview gesture for autoplay
		}),
		vscode.commands.registerCommand("khmerdict.voiceSearch", async () => {
			// Record on the machine through the audio server rather than in the
			// webview: VS Code may refuse a webview the microphone, and this way
			// voice search works from the command palette with no panel open.
			if (!(await ensureServer(true))) { return; }
			let health;
			try { health = await httpGetJson(audioBaseUrl() + "/health", 2000); }
			catch (e) { vscode.window.showErrorMessage("Khmer Dictionary: audio server not reachable — " + e.message); return; }
			const engines = health.stt || [];
			if (!engines.length) {
				vscode.window.showWarningMessage(
					"Khmer Dictionary: no speech-to-text key configured. Add one to api_keys.txt — see API_ACCESS.md.");
				return;
			}
			if (!health.mic) {
				vscode.window.showWarningMessage("Khmer Dictionary: the audio server found no microphone (needs ffmpeg).");
				return;
			}
			const cfg = vscode.workspace.getConfiguration("khmerDictionary");
			const secs = cfg.get("recordSeconds") || 4;
			const want = cfg.get("sttEngine") || "gemini";
			const engine = engines.includes(want) ? want : engines[0];
			const url = audioBaseUrl() + "/record?seconds=" + secs + "&engine=" + encodeURIComponent(engine);
			const j = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification,
				  title: `🎙 និយាយឥឡូវ / Speak now (${secs}s, ${engine})…` },
				() => httpGetJson(url, (secs + 30) * 1000).catch(e => ({ error: e.message })));
			if (j.error) { vscode.window.showErrorMessage("Khmer Dictionary: " + j.error); return; }
			const text = (j.text || "").trim();
			if (!text) { vscode.window.showWarningMessage("Khmer Dictionary: nothing recognised — try again."); return; }
			openPanel(context, text);
		}),
		vscode.commands.registerCommand("khmerdict.openSettings", () =>
			vscode.commands.executeCommand("workbench.action.openSettings",
				"@ext:camgsm.khmer-dictionary")),
		vscode.commands.registerCommand("khmerdict.testAudio", async () => {
			const url = audioBaseUrl() + "/health";
			try {
				const j = await httpGetJson(url, 2500);
				health = { sources: j.sources || [], ts: Date.now() };
				vscode.window.showInformationMessage(
					`Audio server OK at ${url} — voices: ${(j.sources || []).join(", ") || "none"}`);
			} catch (e) {
				vscode.window.showErrorMessage(
					`Cannot reach audio server at ${url}. Start it with start_with_audio.bat ` +
					`(python server.py) — not start.bat. (${e.message})`);
			}
		}),
		vscode.commands.registerCommand("khmerdict.startServer", async () => {
			const ok = await ensureServer(true);
			if (ok) {
				vscode.window.showInformationMessage("Khmer Dictionary: audio server is running.");
				if (panel && panelReady) { panel.webview.postMessage({ type: "reprobe" }); }
			}
		}),
		vscode.commands.registerCommand("khmerdict.restartServer", async () => {
			// Ask a server we did not start to restart itself; otherwise just
			// respawn our own child process.
			let asked = false;
			try {
				await new Promise((res, rej) => {
					const u = new URL(audioBaseUrl() + "/restart");
					const lib = u.protocol === "https:" ? https : http;
					const req = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname,
						method: "POST", timeout: 2000 }, r => { r.resume(); res(); });
					req.on("timeout", () => req.destroy(new Error("timeout")));
					req.on("error", rej);
					req.end();
				});
				asked = true;
			} catch (e) { /* not running, or too old to know /restart */ }
			if (!asked) { stopServer(); }
			for (let i = 0; i < 20; i++) {
				await sleep(500);
				if (await serverReachable(800)) {
					reprobeAll();
					vscode.window.setStatusBarMessage("Khmer Dictionary: audio service restarted", 3000);
					return;
				}
				if (i === 2 && !asked) { await ensureServer(true); }
			}
			const ok = await ensureServer(true);
			if (ok) { reprobeAll(); }
			else { vscode.window.showWarningMessage("Khmer Dictionary: the audio service did not come back."); }
		}),
		vscode.commands.registerCommand("khmerdict.stopServer", () => {
			stopServer();
			vscode.window.showInformationMessage("Khmer Dictionary: audio server stopped.");
		}),
		vscode.languages.registerHoverProvider("*", makeHoverProvider(context))
	);
}

function deactivate() { stopServer(); }

module.exports = { activate, deactivate };
