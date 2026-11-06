/**
 * 抓 disable-devtool 库的真实源码（走浏览器，绕开沙箱网络限制）
 * 用法：node tools/probe_devtool_body.js
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const OUT = path.resolve(__dirname, "probe_out");

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=C:/WINDOWS/Temp/tvlive-lib-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws")); });

  let id = 0; const pend = new Map(); let saved = false;
  const send = (m2, p) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m2, params: p || {} })); });
  sock.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Fetch.requestPaused" && m.params.responseStatusCode && !saved) {
      const { requestId, request } = m.params;
      saved = true;
      const body = await send("Fetch.getResponseBody", { requestId });
      const txt = body.result && body.result.base64Encoded
        ? Buffer.from(body.result.body, "base64").toString("utf8")
        : (body.result && body.result.body) || "";
      fs.writeFileSync(path.join(OUT, "disable-devtool-real.js"), txt, "utf8");
      console.log("已保存 disable-devtool-real.js  " + txt.length + " 字节  来自 " + request.url);
      await send("Fetch.continueRequest", { requestId });
      // 分析
      const i = txt.indexOf("permission to use DEVTOOL");
      console.log("\n=== 判定消息附近的代码 ===");
      if (i >= 0) console.log(JSON.stringify(txt.slice(Math.max(0, i - 900), i + 300)));
      console.log("\n=== 所有 type 数字 + 说明串 ===");
      (txt.match(/[^"'`]{0,50}(debugger|performance|console|toString|devtool)[^"'`]{0,60}/gi) || []).slice(0, 25)
        .forEach((s) => console.log("   " + s.replace(/\s+/g, " ").slice(0, 130)));
      console.log("\n=== 默认处置（about:blank / close / open）===");
      ["about:blank", "location.href", "_self", "close()", "ondevtoolopen", "ondevtoolclose", "isDevToolsOpened", "type===6", "6:"]
        .forEach((k) => { let c = 0, j = -1; while ((j = txt.indexOf(k, j + 1)) >= 0) c++; console.log("   " + k + " × " + c); });
      try { sock.close(); } catch (x) {}
      try { proc.kill(); } catch (x) {}
      return;
    }
    if (m.method === "Fetch.requestPaused") { send("Fetch.continueRequest", { requestId: m.params.requestId }); }
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*disable-devtool*", requestStage: "Response" }] });
  await send("Page.navigate", { url: "about:blank" });
  await sleep(500);
  // 直接在当前页里请求该脚本（用 script 标签，避免 CORS 限制），命中拦截后取 body
  await send("Runtime.evaluate", { expression: "(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/disable-devtool@latest?x='+Date.now();document.body.appendChild(s);return 'go'})()" });
  for (let i = 0; i < 30 && !saved; i++) await sleep(500);
  if (!saved) {
    console.log("没抓到（可能该脚本在 about:blank 里加载失败）");
    try { sock.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
  }
})().catch((e) => { console.log("异常：" + e.stack); process.exit(1); });
