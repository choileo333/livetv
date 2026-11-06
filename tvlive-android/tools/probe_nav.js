/**
 * 导航/请求取证：看清「页面怎么变成 about:blank 的」
 * 用法：node tools/probe_nav.js <播放页URL> [shield 0/1]
 * 记录：每次 frame 导航（含 about:blank）、每次 Fetch 暂停的请求、文档地址随时间变化
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = "https://tvlive-relay.app.workbuddy.host";
const TARGET = process.argv[2];
const SHIELD = process.argv[3] === "1";
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=C:/WINDOWS/Temp/tvlive-nav-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,720",
    "--ignore-certificate-errors", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws")); });

  let id = 0; const pend = new Map(); const lines = []; let pausedCount = 0, shielded = 0;
  const send = (m2, p) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m2, params: p || {} })); });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Fetch.requestPaused") {
      const { requestId, request, frameId } = m.params;
      pausedCount++;
      const isAnti = /disabledev2\.js|disable-devtool/i.test(request.url);
      if (pausedCount <= 40) lines.push("REQ  " + (isAnti ? "★" : " ") + " " + request.url.slice(0, 110));
      if (isAnti && SHIELD) { shielded++; send("Fetch.failRequest", { requestId, errorReason: "Aborted" }); return; }
      send("Fetch.continueRequest", { requestId });
      return;
    }
    if (m.method === "Page.frameNavigated") {
      const fr = m.params.frame;
      lines.push("NAV  " + (fr.parentId ? "子帧" : "主帧") + " → " + String(fr.url).slice(0, 110));
    }
    if (m.method === "Page.frameDetached") lines.push("DETACH " + m.params.frameId.slice(0, 8));
    if (m.method === "Runtime.consoleAPICalled") {
      const t = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      if (t && (/DEVTOOL|permission|close/i.test(t))) lines.push("JS   " + t.slice(0, 110));
    }
    if (m.method === "Log.entryAdded" && /javascript/i.test(m.params.entry.url || "")) {
      lines.push("LOG  " + m.params.entry.level + " " + m.params.entry.text.slice(0, 110));
    }
  };
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: "eval 失败" };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });

  console.log("目标：" + TARGET);
  console.log("屏蔽反调试=" + SHIELD + "（Fetch 全量拦截，仅用于取证）\n");
  await send("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(TARGET) });
  for (let t = 2; t <= 14; t += 2) {
    await sleep(2000);
    const st = await ev("(function(){return {href:location.href, ready:document.readyState, ifr:document.getElementsByTagName('iframe').length}})()");
    console.log("t≈" + t + "s  " + JSON.stringify(st));
  }
  console.log("\n--- 事件时间线 ---");
  lines.forEach((l) => console.log("  " + l));
  console.log("\n请求暂停总数=" + pausedCount + "  被屏蔽=" + shielded);
  try { sock.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
})().catch((e) => { console.log("异常：" + e.stack); process.exit(1); });
