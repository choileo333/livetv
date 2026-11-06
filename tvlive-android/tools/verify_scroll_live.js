/**
 * 线上真实回放站 · 边缘滚动验证
 * ─────────────────────────────────────────────────────────────
 * 为什么需要它：verify_tvnav.js 用的是**自造的模拟页面**，只能证明脚本逻辑自洽；
 * 而「红点贴到屏幕边缘到底能不能把回放站滚起来」取决于**真实站点的滚动结构**
 * （根滚动器是谁、有没有内部可滚容器、有没有 CSS 拦滚），模拟页面证明不了。
 *
 * 做法：用无头 Chrome 打开**真实**的 /api/embed?url=<回放站列表页>，
 *      把 TvNavScript.kt 里那份脚本原样注入，然后真实注入按键，
 *      直接读 window.scrollY / documentElement.scrollTop 看有没有动。
 *
 * 用法：node tools/verify_scroll_live.js
 * 依赖：能访问 https://tvlive-relay.app.workbuddy.host（后端在线）；本机装有 Chrome/Edge。
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const KT = path.join(ROOT, "app/src/main/java/com/leo/tvlive/util/TvNavScript.kt");

const BASE = "https://tvlive-relay.app.workbuddy.host";
const LIST_PAGE = "https://www.dodotv20.com/show.php?tid=3&order_type=";
// 播放页不要写死 id：站点内容天天换，固定 id 早晚失效（失效后 relay 会回退到我们自己的兜底页，
// 于是「页面没有可滚内容」这种假失败就冒出来了）。改成跑之前从列表页现抓一个。
let PLAY_PAGE = "https://www.dodotv20.com/shplay.php?id=3fe45fa5afdd5ba52ca9492f770322e968f429782402b49098d5bb03e629f3e9";

/** 从列表页现抓一个**仍然有效**的详情页地址（为空则保留上面的兜底旧 id） */
async function freshPlayPage() {
  try {
    const r = await fetch(BASE + "/api/embed?url=" + encodeURIComponent(LIST_PAGE), {
      headers: { "User-Agent": "Mozilla/5.0 TvLiveVerify/1.0" },
    });
    const html = await r.text();
    const re = /\/api\/embed\?url=([^"'\s]+)/g;
    let m;
    while ((m = re.exec(html))) {
      let u; try { u = decodeURIComponent(m[1]); } catch (e) { continue; }
      if (/shplay\.php\?id=/.test(u)) return u;
    }
  } catch (e) {}
  return null;
}

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log("  ✅ " + n + (extra ? "  —— " + extra : "")); }
  else { fail++; console.log("  ❌ " + n + (extra ? "  —— " + extra : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 提取注入脚本（与 App 运行时同一份源码）──
const ktSrc = fs.readFileSync(KT, "utf8");
const m = ktSrc.match(/"""\n([\s\S]*?)\n"""\s*\.trimIndent\(\)/);
if (!m) { console.log("❌ 未能从 TvNavScript.kt 提取脚本"); process.exit(1); }
const VERSION = Number((ktSrc.match(/VERSION\s*=\s*(\d+)/) || [])[1] || 0);
const js = m[1].replace(/\$VERSION/g, String(VERSION));
console.log("注入脚本 " + js.length + " 字节，VERSION=" + VERSION);

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) { console.log("⚠️ 未找到 Chrome/Edge，跳过（本机无法做真实站点验证）"); process.exit(0); }
console.log("浏览器：" + chrome + "\n");

(async () => {
  const userDir = "C:/WINDOWS/Temp/tvlive-live-scroll-" + Date.now();
  const proc = spawn(chrome, [
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + userDir,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1920,1080", "--ignore-certificate-errors", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let wsUrl = null;
  proc.stderr.on("data", (b) => {
    const mm = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (mm) wsUrl = mm[1];
  });
  for (let i = 0; i < 120 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.log("❌ 无头浏览器未就绪"); try { proc.kill(); } catch (e) {} process.exit(1); }

  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws 连接失败")); });

  let id = 0; const pend = new Map();
  sock.onmessage = (e) => { const mm = JSON.parse(e.data); if (mm.id && pend.has(mm.id)) { pend.get(mm.id)(mm); pend.delete(mm.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __err: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable"); await send("Runtime.enable");

  // 现抓一个有效播放页，避免旧 id 失效导致的假失败
  const freshPlay = await freshPlayPage();
  if (freshPlay) PLAY_PAGE = freshPlay;
  console.log("本轮播放页：" + PLAY_PAGE);
  console.log("");

  for (const [label, target] of [["回放站·列表页", LIST_PAGE], ["回放站·播放页", PLAY_PAGE]]) {
    console.log("═".repeat(64));
    console.log("【" + label + "】");
    console.log("═".repeat(64));
    await send("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(target) });

    // 等页面真正就绪：远端站点（经中继回源）偶发慢，固定 sleep 会误判成「页面没有可滚内容」。
    // 判据：document.body 已存在，且根滚动器已算出大于视口的可滚高度。
    let struct = null;
    for (let i = 0; i < 40; i++) {
      await sleep(800);
      struct = await ev(`(function(){
        if(!document.body) return null;
        var de=document.documentElement, bd=document.body, se=document.scrollingElement||de;
        return { title:(document.title||'').slice(0,40),
                 vw:window.innerWidth, vh:window.innerHeight,
                 seTag: se?se.tagName:'(none)',
                 htmlOY: getComputedStyle(de).overflowY,
                 bodyOY: getComputedStyle(bd).overflowY,
                 htmlScrollable: de.scrollHeight > de.clientHeight + 2,
                 maxY: se.scrollHeight - se.clientHeight };
      })()`);
      if (struct && struct.__err) struct = null;
      if (struct && struct.maxY > 200) break;
    }
    if (!struct) { ok(label + "：页面可读取", false, "页面始终未就绪（document.body 为空）"); continue; }
    console.log("  页面：" + struct.title);
    console.log("  视口 " + struct.vw + "x" + struct.vh + " · 根滚动器 <" + struct.seTag + ">" +
                " · html overflow-y=" + struct.htmlOY + " · body overflow-y=" + struct.bodyOY +
                " · 可滚高度=" + struct.maxY);

    if (struct.maxY < 200) {
      ok(label + "：页面本身够长、值得滚动", false, "可滚高度仅 " + struct.maxY + "px，无法验证");
      continue;
    }

    // 注入与 App 完全相同的脚本，并把红点推到下边缘
    const inj = await ev(js + "; 'injected'");
    ok(label + "：注入脚本无异常", inj === "injected", String(inj && inj.__err || inj));

    await ev("window.scrollTo(0,0)");
    await ev("window.__tvNav && window.__tvNav.reset()");
    await sleep(200);

    // 先走到下边缘（不滚动的那几步），再进入贴边区
    await ev("(function(){for(var i=0;i<6;i++)window.__tvNav.key(20);})()");
    await sleep(250);
    const midY = await ev("(document.scrollingElement||document.documentElement).scrollTop");

    // 关键动作：贴着下边缘继续按「下」
    await ev("(function(){for(var i=0;i<10;i++)window.__tvNav.key(20);})()");
    await sleep(400);
    const afterY = await ev("(document.scrollingElement||document.documentElement).scrollTop");
    const pDown = await ev("window.__tvNav.pos()");

    ok(label + "：红点贴到屏幕下边缘后按「下」，页面真的向下滚动",
      afterY > 0, "scrollTop 0 → " + afterY + "（中间态 " + midY + "）");
    ok(label + "：红点仍留在屏幕内（贴边判定带生效，不会被切出屏幕）",
      pDown && pDown.y >= 8 && pDown.y <= struct.vh - 8, JSON.stringify(pDown) + " / 视口高 " + struct.vh);

    // 反向：贴到上边缘继续按「上」，页面滚回顶部
    await ev("(function(){for(var i=0;i<40;i++)window.__tvNav.key(19);})()");
    await sleep(400);
    const backY = await ev("(document.scrollingElement||document.documentElement).scrollTop");
    ok(label + "：贴到上边缘后按「上」能把页面滚回顶部（双向都通）", backY === 0,
      "scrollTop " + afterY + " → " + backY);

    // 红点下仍然能正确命中网页元素（滚动后命中测试没被打乱）
    const hit = await ev("window.__tvNav.hit()");
    ok(label + "：滚动后红点的命中测试仍返回真实网页元素",
      typeof hit === "string" && hit.length > 0,
      "命中=" + (hit && hit.__err ? ("【脚本异常】" + hit.__err) : hit));
    console.log("");
  }

  try { sock.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}

  console.log("═".repeat(64));
  console.log("结果：通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("  ❌ 验证异常：" + e.message); process.exit(1); });
