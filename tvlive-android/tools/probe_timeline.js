/**
 * 播放页「时间线」勘察：每 3 秒采一次样，看清页面到底怎么演的
 * 用法：node tools/probe_timeline.js <播放页URL> [是否屏蔽反调试脚本 0/1]
 *
 * 采样内容：文档地址/就绪状态 → iframe 清单（src + 能否下钻 + 里面有没有 #video-container / video）
 *          → 顶层 video 数 → #adFrame / #view_iframe 的显示状态
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
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=C:/WINDOWS/Temp/tvlive-tl-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,720",
    "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws")); });

  let id = 0; const pend = new Map(); const logs = [];
  const send = (m2, p) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m2, params: p || {} })); });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Fetch.requestPaused") {
      const { requestId, request } = m.params;
      const shieldUrl = /disabledev2\.js|disable-devtool/.test(request.url);
      if (shieldUrl) { logs.push("[屏蔽] " + request.url.slice(0, 80)); send("Fetch.failRequest", { requestId, errorReason: "Aborted" }); }
      else send("Fetch.continueRequest", { requestId });
      return;
    }
    if (m.method === "Runtime.consoleAPICalled") {
      const t = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      if (t) logs.push("[js] " + t.slice(0, 120));
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      logs.push("[EXC] " + (((d.exception || {}).description || d.text || "").slice(0, 160)));
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") logs.push("[ERR] " + m.params.entry.text.slice(0, 120));
  };
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: ((r.result.exceptionDetails.exception || {}).description) || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  if (SHIELD) await send("Fetch.enable", { patterns: [{ urlPattern: "*disabledev2.js*", requestStage: "Request" }, { urlPattern: "*disable-devtool*", requestStage: "Request" }] });

  const probe = `(function(){
    var o = { href: location.href.slice(0, 90), ready: document.readyState, frames: [], topVideos: document.getElementsByTagName('video').length };
    var ad=document.getElementById('adFrame'), vi=document.getElementById('view_iframe');
    o.ad = ad ? getComputedStyle(ad).display : '(无)';
    o.vi = vi ? getComputedStyle(vi).display : '(无)';
    var fs = document.getElementsByTagName('iframe');
    for (var i=0;i<fs.length && i<5;i++){
      var r = fs[i].getBoundingClientRect();
      var rec = { src: String(fs[i].getAttribute('src')||'').slice(0,70), w: Math.round(r.width), h: Math.round(r.height), doc: null };
      try {
        var d = fs[i].contentDocument;
        if (d) rec.doc = { title: d.title, bodyH: d.body ? d.body.clientHeight : -1,
                           box: !!d.getElementById('video-container'), videos: d.getElementsByTagName('video').length,
                           bodyHead: d.body ? d.body.innerHTML.replace(/\\s+/g,' ').slice(0,120) : '' };
        else rec.doc = 'BLOCKED';
      } catch(e){ rec.doc = 'BLOCKED'; }
      o.frames.push(rec);
    }
    return o;
  })()`;

  console.log("打开：" + BASE + "/api/embed?url=" + encodeURIComponent(TARGET));
  if (SHIELD) console.log("（本轮屏蔽反调试脚本 disabledev2.js / disable-devtool）");
  await send("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(TARGET) });
  for (let t = 3; t <= 30; t += 3) {
    await sleep(3000);
    const st = await ev(probe);
    console.log("\n── t ≈ " + t + "s ──");
    console.log("  地址=" + (st && st.href) + "  ready=" + (st && st.ready) + "  顶层video=" + (st && st.topVideos) + "  ad=" + (st && st.ad) + "  view_iframe=" + (st && st.vi));
    ((st && st.frames) || []).forEach((f, i) => {
      const d = f.doc;
      console.log("   iframe[" + i + "] " + f.w + "×" + f.h + "  " + f.src);
      if (d === "BLOCKED") console.log("       ↳ 跨域，进不去");
      else if (d) console.log("       ↳ title='" + d.title + "' body高=" + d.bodyH + " #video-container=" + d.box + " video数=" + d.videos + "  内容头=" + JSON.stringify(d.bodyHead));
    });
  }
  console.log("\n── 关键日志（去重后前 30 条）──");
  [...new Set(logs)].slice(0, 30).forEach((l) => console.log("  " + l));
  try { sock.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
})().catch((e) => { console.log("异常：" + e.stack); process.exit(1); });
