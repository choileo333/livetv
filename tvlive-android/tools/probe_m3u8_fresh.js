/**
 * 探针：现抓「新鲜」的 m3u8 地址，立刻用不同 Referer 试探它是否可播
 * ─────────────────────────────────────────────────────────────
 * 目的：分清这两个可能
 *   (a) token 有时效 —— 抓下来几秒后就失效（那必须「抓完立刻播」）
 *   (b) 需要特定 Referer —— 送对头就能播（那 relay 的 ref 传错了）
 *
 * 做法：无头 Chrome 打开详情页（经 /api/embed 包装，与 App 完全一致），
 *      读出 view_iframe 的 src，把内层真实 .m3u8 解出来，
 *      然后由 Node 侧立刻用 4 种 Referer 组合去拉它，打印状态码/类型/前几行。
 *
 * 用法：node tools/probe_m3u8_fresh.js
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = "https://tvlive-relay.app.workbuddy.host";
const LIST_PAGE = "https://www.dodotv20.com/show.php?tid=3&order_type=";
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从列表页现抓一个详情页地址 */
async function freshPlayPage() {
  const r = await fetch(BASE + "/api/embed?url=" + encodeURIComponent(LIST_PAGE), {
    headers: { "User-Agent": "Mozilla/5.0 TvLiveProbe/1.0" },
  });
  const html = await r.text();
  const re = /\/api\/embed\?url=([^"'\s]+)/g;
  let m;
  while ((m = re.exec(html))) {
    let u; try { u = decodeURIComponent(m[1]); } catch (e) { continue; }
    if (/shplay\.php\?id=/.test(u)) return u;
  }
  return null;
}

/**
 * 「这串本身是不是一个 m3u8 地址」——必须看 pathname 真的以 .m3u8 结尾，
 * 不能用 indexOf('.m3u8')：onet.php?url=xxx.m3u8 这种「m3u8 只是个查询参数」
 * 会被误判成 m3u8（这正是 App 里黑屏的老毛病，此处复刻验证）。
 */
function isM3u8(u) {
  const s = String(u || "").split("#")[0].split("?")[0];
  return /\.m3u8$/i.test(s);
}

/** 把 /api/embed?url=<encoded onet.php?url=<m3u8>> 逐层解到最内层真正的 .m3u8 */
function unwrapStream(s) {
  let cur = String(s || "");
  for (let i = 0; i < 6; i++) {
    if (isM3u8(cur)) return cur;
    const m = cur.match(/[?&]url=([^&]+)/);
    if (!m) break;
    let nx; try { nx = decodeURIComponent(m[1]); } catch (e) { break; }
    if (nx === cur) break;
    cur = nx;
  }
  return isM3u8(cur) ? cur : null;
}

(async () => {
  if (!CHROME) { console.log("未找到 Chrome/Edge"); process.exit(1); }
  const page = await freshPlayPage();
  if (!page) { console.log("未抓到详情页地址"); process.exit(1); }
  console.log("详情页：", page);

  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0",
    "--user-data-dir=C:/WINDOWS/Temp/tvlive-probe-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,720",
    "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.log("无头浏览器未就绪"); process.exit(1); }

  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws 失败")); });

  let id = 0; const pend = new Map();
  sock.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg.result || {}); pend.delete(msg.id); }
  };
  const cmd = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await cmd("Page.enable", {});
  await cmd("Runtime.enable", {});
  const ev = async (expr) => {
    const r = await cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  await cmd("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(page) });
  await sleep(11000);

  const srcs = await ev(`(function(){var o=[];var f=document.getElementsByTagName('iframe');for(var i=0;i<f.length;i++){o.push(f[i].getAttribute('src')||'');}return o;})()`);
  console.log("页面内 iframe src（原始）：");
  (srcs || []).forEach((s, i) => console.log("  [" + i + "] " + s));

  let m3u8 = null;
  for (const s of srcs || []) { const u = unwrapStream(s); if (u) { m3u8 = u; break; } }
  if (!m3u8) { console.log("❌ 没能从 iframe src 里解出 m3u8"); sock.close(); proc.kill(); process.exit(1); }
  console.log("");
  console.log("✅ 解出的真实 m3u8：", m3u8);
  console.log("   长度 =", m3u8.length);

  const ua = "Mozilla/5.0 (Linux; Android 9; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.99 Mobile Safari/537.36";
  const trials = [
    ["无 Referer", {}],
    ["Referer=xiaoca.top", { Referer: "https://xiaoca.top/" }],
    ["Referer=dodotv20.com", { Referer: "https://www.dodotv20.com/" }],
    ["Referer=wiselife.blog", { Referer: "https://wiselife.blog/" }],
  ];
  console.log("");
  console.log("立刻拉取（同一 token，只差 Referer）：");
  for (const [name, extra] of trials) {
    const t0 = Date.now();
    try {
      const r = await fetch(m3u8, { headers: Object.assign({ "User-Agent": ua }, extra), redirect: "follow" });
      const body = await r.text();
      const head = body.slice(0, 90).replace(/\s+/g, " ");
      console.log("  " + name.padEnd(24) + " → HTTP " + r.status + "  " + (r.headers.get("content-type") || "?").slice(0, 30) +
        "  " + body.length + "B  " + (Date.now() - t0) + "ms  | " + head);
    } catch (e) {
      console.log("  " + name.padEnd(24) + " → 错误 " + (e && e.message));
    }
  }

  console.log("");
  console.log("等 30 秒后再拉一次同样的地址（检验 token 时效）：");
  await sleep(30000);
  try {
    const r = await fetch(m3u8, { headers: { "User-Agent": ua, Referer: "https://xiaoca.top/" } });
    const body = await r.text();
    console.log("  HTTP " + r.status + "  " + body.length + "B  | " + body.slice(0, 90).replace(/\s+/g, " "));
  } catch (e) { console.log("  错误 " + (e && e.message)); }

  sock.close(); proc.kill();
})().catch((e) => { console.error(e); process.exit(1); });
