/**
 * 「广告倒计时放行脚本到底跑没跑」实测
 * 站点逻辑：DOMContentLoaded 后每秒 -1，到点把 #adFrame 隐藏、#view_iframe 显示出来。
 * 本探针在 t=3s / t=8s / t=16s 三个时间点读状态，并列出仍在挂起的网络请求。
 * 用法：node tools/probe_gate.js <播放页URL>
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = "https://tvlive-relay.app.workbuddy.host";
const TARGET = process.argv[2];
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=C:/WINDOWS/Temp/tvlive-g-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,720",
    "--ignore-certificate-errors", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws")); });

  let id = 0; const pend = new Map(); const logs = []; const reqs = new Map(); const done = new Set();
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const t = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      if (t) logs.push("[js] " + t);
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      logs.push("[EXC] " + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    if (m.method === "Log.entryAdded") { const en = m.params.entry; if (en.level === "error") logs.push("[ERR] " + en.text.slice(0, 200) + " " + (en.url || "")); }
    if (m.method === "Network.requestWillBeSent") reqs.set(m.params.requestId, m.params.request.url);
    if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") done.add(m.params.requestId);
  };
  const send = (m2, p) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m2, params: p || {} })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: ((r.result.exceptionDetails.exception || {}).description) || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable");

  const probe = `(function(){
    var vi = document.getElementById('view_iframe'), ad = document.getElementById('adFrame');
    function box(e){ if(!e) return null; var r=e.getBoundingClientRect();
      return { inline:e.style.display||'(空)', computed:getComputedStyle(e).display, rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)] }; }
    var scripts = document.getElementsByTagName('script'); var hasShow=false;
    for (var i=0;i<scripts.length;i++){ if(/showVideo|countdownInterval/.test(scripts[i].textContent||'')) hasShow=true; }
    return { ready: document.readyState, hasShowVideoScript: hasShow, view: box(vi), ad: box(ad),
      adSrc: ad?ad.getAttribute('src'):null, viSrc: vi?vi.getAttribute('src'):null };
  })()`;

  console.log("页面：" + BASE + "/api/embed?url=" + encodeURIComponent(TARGET));
  await send("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(TARGET) });

  for (const t of [3, 8, 16]) {
    await sleep(t === 3 ? 3000 : 5000);
    console.log("\n── t ≈ " + t + "s ──");
    console.log(JSON.stringify(await ev(probe), null, 2));
    const pending = [...reqs.entries()].filter(([k]) => !done.has(k)).map(([, v]) => v);
    console.log("  仍挂起(" + pending.length + ")：" + pending.slice(0, 12).join("\n     "));
  }

  console.log("\n── 报错汇总（前 25 条）──");
  logs.slice(0, 25).forEach((l) => console.log("  " + l.slice(0, 240)));

  try { sock.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
})().catch((e) => { console.log("异常：" + e.stack); process.exit(1); });
