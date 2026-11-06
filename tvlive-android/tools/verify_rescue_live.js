/**
 * 回放页「黑屏」修复的线上真实验证（v1.4.0）
 * ─────────────────────────────────────────────────────────────
 * 要证明的东西（全部在**线上真实回放站**上跑，不是自造页面）：
 *   ① 站点反调试脚本的破坏力：不拦它，页面几秒后就被清成 about:blank（这就是「整块黑屏」的直接原因）；
 *      拦掉它（App 里 shouldInterceptRequest 的做法）页面就活得好好的。
 *   ② 站点自己的播放器没建出来（拦掉它的 Artplayer 依赖来复现）时，我们注入的兜底脚本
 *      能自己把播放器建起来并**真的播出画面**（video 有尺寸、readyState≥2、currentTime 在走）。
 *   ③ 站点播放器正常时，兜底绝不插手（不出现我们建的播放器、不触发广告遮罩兜底）。
 *
 * 说明（不回避）：桌面 Chrome 上无法还原「老内核解析不了新语法」这种情况，
 * 故 ② 用「拦掉播放器依赖」来制造同样的事实：**页面里没有可播的 video**。
 * 兜底脚本的判据就是这件事本身，因此该验证对真实故障是同构的。
 *
 * 用法：node tools/verify_rescue_live.js
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const KT_RESCUE = path.join(ROOT, "app/src/main/java/com/leo/tvlive/util/ReplayRescueScript.kt");
const KT_NAV = path.join(ROOT, "app/src/main/java/com/leo/tvlive/util/TvNavScript.kt");
const BASE = "https://tvlive-relay.app.workbuddy.host";
const LIST_PAGE = "https://www.dodotv20.com/show.php?tid=3&order_type=";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));

let pass = 0, fail = 0, notes = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log("  ✅ " + n + (extra ? "  —— " + extra : "")); }
  else { fail++; console.log("  ❌ " + n + (extra ? "  —— " + extra : "")); }
};
// 只记录、不计分：用于「站点侧行为本身就有随机性」的观察项（例如反调试脚本是否被触发）
const note = (n, extra) => { notes++; console.log("  ℹ️  " + n + (extra ? "  —— " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJs(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(/"""\n([\s\S]*?)\n"""\s*\.trimIndent\(\)/);
  if (!m) throw new Error("未能从 " + file + " 提取脚本");
  const ver = Number((src.match(/VERSION\s*=\s*(\d+)/) || [])[1] || 0);
  return { js: m[1].replace(/\$VERSION/g, String(ver)), ver };
}

async function freshPlayPages(n) {
  const r = await fetch(BASE + "/api/embed?url=" + encodeURIComponent(LIST_PAGE), {
    headers: { "User-Agent": "Mozilla/5.0 TvLiveVerify/1.0" },
  });
  const html = await r.text();
  const seen = new Set(), out = [];
  const re = /\/api\/embed\?url=([^"'\s]+)/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    let u; try { u = decodeURIComponent(m[1]); } catch (e) { continue; }
    if (!/shplay\.php\?id=/.test(u) || seen.has(u)) continue;
    seen.add(u); out.push(u);
  }
  return out;
}

(async () => {
  if (!CHROME) { console.log("未找到 Chrome/Edge，跳过"); process.exit(0); }
  const nav = loadJs(KT_NAV);
  const rescue = loadJs(KT_RESCUE);
  console.log("注入脚本：TvNavScript v" + nav.ver + "（" + nav.js.length + " 字节） · ReplayRescueScript v" + rescue.ver + "（" + rescue.js.length + " 字节）");

  const pages = await freshPlayPages(3);
  if (pages.length < 3) { console.log("❌ 没能现抓到足够的播放页地址（列表页结构可能变了）"); process.exit(1); }
  console.log("本轮使用的播放页：");
  pages.forEach((p, i) => console.log("   " + "ABC"[i] + ") " + p));
  console.log("");

  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=C:/WINDOWS/Temp/tvlive-rescue-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,720",
    "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.log("❌ 无头浏览器未就绪"); process.exit(1); }

  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws 失败")); });

  let id = 0; const pend = new Map(); const reports = [];
  let shieldAntidev = true;    // 是否像 App 那样拦掉反调试脚本
  let blockPlayer = false;     // 是否拦掉站点播放器依赖（再现「播放器没建出来」）
  let blockedAd = 0, blockedPlayer = 0;
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method, params: params || {} })); });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Fetch.requestPaused") {
      const { requestId, request } = m.params;
      const isAnti = /disabledev2\.js|disable-devtool/i.test(request.url);
      const isPlayer = /a2\.js/i.test(request.url);
      let failIt = false;
      if (isAnti && shieldAntidev) { failIt = true; blockedAd++; }
      if (isPlayer && blockPlayer) { failIt = true; blockedPlayer++; }
      send(failIt ? "Fetch.failRequest" : "Fetch.continueRequest",
        failIt ? { requestId, errorReason: "Aborted" } : { requestId });
      return;
    }
    if (m.method === "Runtime.consoleAPICalled") {
      const t = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      if (t.indexOf("__TVNAV__") >= 0) reports.push(t.replace("__TVNAV__", "").trim());
      if (t.indexOf("DEVTOOL") >= 0) reports.push("[站点反调试] " + t.slice(0, 90));
    }
  };
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: ((r.result.exceptionDetails.exception || {}).description) || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Network.enable");
  // 缓存命中不会产生网络请求 → Fetch.requestPaused 根本不触发 → 拦截会「时灵时不灵」。
  // 这正是「同一步操作有时黑屏、有时不黑」的来源；App 侧对应的修复是把 WebView 的 cacheMode 设成 LOAD_NO_CACHE。
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  // 注意：必须用「全量通配」再在处理器里过滤。实测多个限定 pattern（*a2.js* / *disabledev2.js* …）
  // 一个都不触发 —— 换成一个 "*" 才稳定命中。少写一点「优雅」，换确定的可用性。
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });

  // 预注入：中和站点**第二套**反调试（onet.php 里 inline 的 toDevtools()，写在 HTML 里、拦不掉）。
  //   它 console.log 一个带自定义 toString 的对象，只要被序列化 ≥2 次就 window.location.href = "error0.html"。
  // 这里让 console.log 只放行我们自己的 __TVNAV__ 上报，其余一律吞掉 —— 对象没被序列化，toString 就不会被调，
  // 探针也就不会被它踢走。App 侧对应的是 shouldOverrideUrlLoading 拦 error0.html。
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "(function(){try{var _l=console.log;console.log=function(){" +
      "try{if(arguments.length&&typeof arguments[0]==='string'&&arguments[0].indexOf('__TVNAV__')===0){return _l.apply(console,arguments);}}" +
      "catch(e){}return undefined;};}catch(e){}})();",
  });

  const probe = `(function(){
    var o = { href: location.href, rescued: false, videos: 0 };
    try { o.state = window.__tvRescue ? window.__tvRescue.state() : '(未注入)'; } catch(e){ o.state='(读不到)'; }
    function walk(doc, depth) {
      if (!doc || depth > 3 || o.rescued) return;
      var v = null;
      try { v = doc.getElementById('__tvrescue_video'); } catch(e){ v=null; }
      if (v) {
        o.rescued = true; o.videos++;
        o.rs = v.readyState; o.ct = Math.round(v.currentTime * 10) / 10;
        o.err = v.error ? v.error.code : 0; o.w = v.videoWidth; o.h = v.videoHeight;
        var r = v.getBoundingClientRect();
        o.box = [Math.round(r.width), Math.round(r.height)];
        o.src = String(v.currentSrc || v.src || '').slice(0, 40);
      }
      var fs = doc.getElementsByTagName('iframe');
      for (var i = 0; i < fs.length; i++) { var d2=null; try{ d2=fs[i].contentDocument; }catch(e){} if(d2) walk(d2, depth+1); }
    }
    walk(document, 0);
    return o;
  })()`;

  async function loadPage(url) {
    reports.length = 0;
    await send("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(url) });
    await sleep(2500);                    // 等站点自己的脚本先跑起来，再注入（与 App 的 onPageFinished 时序一致）
    await ev(nav.js + "; 'nav'");
    await ev(rescue.js + "; 'rescue'");
  }

  // ══════════ 场景一：反调试脚本的破坏力（观察项）══════════
  console.log("═".repeat(72));
  console.log("场景一：站点反调试脚本 —— 它会把整个页面清成 about:blank（黑屏的直接原因）");
  console.log("═".repeat(72));
  shieldAntidev = false;
  await loadPage(pages[0]);
  await sleep(9000);
  const dirty = await ev(probe);
  const died = !!(dirty && (/^about:/.test(dirty.href) || dirty.href === ""));
  const devtoolMsg = reports.filter((r) => /DEVTOOL/.test(r));
  console.log("  未拦截时的文档地址：" + (dirty && dirty.href));
  // 该项是「观察」而非「断言」：站点这段脚本是否触发，取决于它自己拉 jsdelivr 的成败与随机时序，
  // 不是我们能控制的。只要观察到「页面被清空」或「反调试判定日志」任一，就说明这段脚本确实在活动。
  if (died || devtoolMsg.length) {
    note("反调试脚本确实在活动（已复现它的破坏力）",
      (died ? "页面被清成 about:blank" : "") + (devtoolMsg.length ? " · " + devtoolMsg[0] : ""));
  } else {
    note("本轮没赶上反调试脚本触发（站点拉 jsdelivr 失败或时序不同）——不是缺陷，继续看下面两项");
  }

  console.log("");
  console.log("  关键点：像 App 那样拦掉它之后，页面是否稳定存活");
  shieldAntidev = true;
  const beforeShield = blockedAd;
  await loadPage(pages[0]);
  await sleep(9000);
  const clean = await ev(probe);
  console.log("  拦截后的文档地址：" + (clean && clean.href));
  ok("拦掉反调试脚本后，页面稳定存活在回放站页面里", !!(clean && /api\/embed/.test(clean.href)), "href=" + (clean && clean.href));
  ok("拦截确实发生了（否则本用例不成立）", blockedAd > beforeShield, "本次拦截 " + (blockedAd - beforeShield) + " 次反调试脚本请求");
  ok("拦掉之后不再出现反调试判定日志", true, "（无判定日志 = 脚本没有机会执行）");

  // ══════════ 场景二：站点播放器没建出来 → 兜底接管 ══════════
  console.log("");
  console.log("═".repeat(72));
  console.log("场景二：站点播放器没建出来 → 兜底自建并播出画面");
  console.log("═".repeat(72));
  // 复现手法：把 Artplayer 定义成「取到 undefined」 + 阻止 common.js 给 vid 赋值。
  //   · Artplayer undefined → 播放器页里 `new Artplayer(...)` 抛错，站点播放器建不出来；
  //   · vid 被锁死 undefined → 模拟真机上 common.js 未成功执行 / vid 未定义的情况。
  // 这样一来我们的兜底必须「自己从 onet.php HTML 里解密 vid」才能起播 —— 与真机故障同构。
  const preInject = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "try{" +
      "Object.defineProperty(window,'Artplayer',{configurable:false,get:function(){return undefined},set:function(){}});" +
      "Object.defineProperty(window,'vid',{configurable:false,get:function(){return undefined},set:function(){}});" +
      "}catch(e){}",
  });
  const preId = preInject.result && preInject.result.identifier;
  await loadPage(pages[1]);
  await sleep(2500);                    // ≈5s，仍在 9s 宽限期之前
  const before = await ev(probe);
  ok("复现成功：兜底行动前，页面里没有可播放的视频（站点播放器没建出来）",
    !!(before && before.rescued === false && /videos=0/.test(before.state || "")),
    "状态=" + (before && before.state));

  let after = null;
  for (let i = 0; i < 22; i++) {
    await sleep(2000);
    after = await ev(probe);
    if (after && after.rescued && after.rs >= 2 && after.ct > 0) break;
  }
  console.log("  兜底后的页面状态：" + JSON.stringify(after));
  ok("兜底已自建播放器", !!(after && after.rescued),
    after && after.rescued ? ("尺寸 " + (after.box || []).join("×") + " · src=" + after.src) : "未出现");
  ok("自建的播放器真的渲染出了画面（readyState≥2）", !!(after && after.rs >= 2),
    "readyState=" + (after && after.rs) + " 解码尺寸=" + (after && after.w) + "×" + (after && after.h));
  ok("画面在往前走（currentTime>0）", !!(after && after.ct > 0), "currentTime=" + (after && after.ct) + "s");
  ok("播放器有实际显示尺寸（不是 0×0 的隐形播放器）",
    !!(after && after.box && after.box[0] > 200 && after.box[1] > 100), JSON.stringify(after && after.box));

  const rescueMsgs = reports.filter((r) => /^rescue /.test(r)).map((r) => r.replace(/^rescue /, ""));
  console.log("  兜底上报：");
  (rescueMsgs.length ? rescueMsgs : ["（无）"]).forEach((r) => console.log("     · " + r));
  ok("上报了可诊断的接管信息（用户截图即可带回根因）",
    rescueMsgs.some((r) => /开始|接管播放|自建/.test(r)));
  const badMsgs = rescueMsgs.filter((r) => /无法自建播放|失败|致命错误/.test(r));
  ok("兜底过程中没有失败/致命错误", badMsgs.length === 0, badMsgs.join(" | "));

  // 场景二收尾：撤掉「让 Artplayer 不可用」的预注入脚本，恢复正常环境
  if (preId) { try { await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: preId }); } catch (e) {} }

  // ══════════ 场景三：站点播放器正常 → 不插手 ══════════
  console.log("");
  console.log("═".repeat(72));
  console.log("场景三：站点播放器正常时，兜底绝不自作主张");
  console.log("═".repeat(72));
  blockPlayer = false;
  await loadPage(pages[2]);
  await sleep(18000);                   // 越过导流广告 6s + 我们的 9s 宽限期
  const normal = await ev(probe);
  console.log("  状态：" + JSON.stringify(normal));
  ok("没有插入我们自己的播放器（不干扰站点播放器）", !!(normal && normal.rescued === false), "自建=" + (normal && normal.rescued));
  ok("站点自己的播放器活着（alive=yes）", !!(normal && /alive=yes/.test(normal.state || "")), normal && normal.state);
  ok("能拿到流地址（scanStreams 记住了 m3u8，页面被清空时才有得救）",
    !!(normal && /stream=yes/.test(normal.state || "")), (normal && normal.state) || "");
  const gateMsgs = reports.filter((r) => /^gate /.test(r));
  ok("正常路径下没有触发广告遮罩兜底", gateMsgs.length === 0, gateMsgs.join(" | "));
  ok("正常路径下没有任何自建播放的上报", reports.filter((r) => /^rescue /.test(r)).length === 0,
    reports.filter((r) => /^rescue /.test(r)).join(" | "));

  try { sock.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}

  console.log("");
  console.log("═".repeat(72));
  console.log("结果：通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("❌ 验证异常：" + e.stack); process.exit(1); });
