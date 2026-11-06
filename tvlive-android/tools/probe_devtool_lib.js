/**
 * 下载并分析站点用的反调试库 disable-devtool
 * 目的：搞清 【type = 6】 是哪一种检测、在 WebView / 无头浏览器里为什么会误判。
 * 用法：node tools/probe_devtool_lib.js
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
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=C:/WINDOWS/Temp/tvlive-dt-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws")); });
  let id = 0; const pend = new Map();
  sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m2, p) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m2, params: p || {} })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: ((r.result.exceptionDetails.exception || {}).description) || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable"); await send("Runtime.enable");

  const urls = [
    "https://cdn.jsdelivr.net/npm/disable-devtool@latest",
    "https://cdn.jsdelivr.net/npm/disable-devtool/package.json",
  ];
  for (const u of urls) {
    const t = await ev("fetch(" + JSON.stringify(u) + ").then(function(r){return r.text()}).catch(function(e){return 'ERR '+e.message})");
    const name = u.endsWith("package.json") ? "disable-devtool-package.json" : "disable-devtool.js";
    if (typeof t === "string" && t.indexOf("ERR ") !== 0) {
      fs.writeFileSync(path.join(OUT, name), t, "utf8");
      console.log("已保存 " + name + "  " + t.length + " 字节");
    } else {
      console.log(u + " 取不到：" + String(t).slice(0, 120));
    }
  }

  // 分析
  const f = path.join(OUT, "disable-devtool.js");
  if (fs.existsSync(f)) {
    const src = fs.readFileSync(f, "utf8");
    console.log("\n=== 版本线索 ===");
    console.log(JSON.stringify((src.match(/VERSION[^,;]{0,40}/g) || []).slice(0, 3)));
    console.log("\n=== 消息与 type 映射 ===");
    let i = src.indexOf("permission to use DEVTOOL");
    console.log("消息字符串位置=" + i);
    if (i >= 0) console.log(JSON.stringify(src.slice(Math.max(0, i - 400), i + 200)));
    console.log("\n=== 所有含 type 的提示串 ===");
    (src.match(/[^"'`]{0,60}type[^"'`]{0,60}/gi) || []).slice(0, 20).forEach((s) => console.log("   " + s.replace(/\s+/g, " ").slice(0, 120)));
    console.log("\n=== 默认行为（about:blank / location）===");
    ["about:blank", "location.href", "window.close", "ondevtoolopen", "isDevToolsOpened"].forEach((k) => {
      let c = 0, j = -1; while ((j = src.indexOf(k, j + 1)) >= 0) c++;
      console.log("   " + k + " × " + c);
    });
  }

  // disabledev2.js 是否也打印同一句
  const dd = path.join(OUT, "disabledev2.js");
  if (fs.existsSync(dd)) {
    const s = fs.readFileSync(dd, "utf8");
    console.log("\n=== disabledev2.js 是否含该消息 ===");
    console.log("   含 'DEVTOOL' = " + /DEVTOOL/i.test(s) + "，含 'permission' = " + /permission/i.test(s));
    console.log("   末尾 400 字：" + JSON.stringify(s.slice(-400)));
  }

  try { sock.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
})().catch((e) => { console.log("异常：" + e.stack); process.exit(1); });
