/**
 * 回放页「去广告 + 单列重排」清理脚本验证器（v1.4.3）
 * ─────────────────────────────────────────────────────────────
 * 目的：ReplayCleanupScript.kt 里注入的 JS 是字符串，编译期查不出语法/逻辑错误，
 *      一旦写错，只能等用户真机操作时才发现（现象多为「广告没去掉/页面塌了」）。
 *      这里用无头 Chrome 加载【真实抓取的详情页】play_embed.html，真实注入清理脚本，
 *      断言：
 *        1) 广告节点（.banner_ / .anchor_banner / #adFrame）数量归 0；
 *        2) 播放器 #view_iframe 与播放列表 .play-box-side-main 仍然在（没被误删）；
 *        3) 整页变为可滚动（scrollHeight > clientHeight），红点贴边滚动才能把下方内容滚出来；
 *        4) 延迟注入的广告（MutationObserver / 定时兜底）也会被清掉。
 *
 * 用法：node tools/verify_cleanup.js
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const KT = path.join(ROOT, "app/src/main/java/com/leo/tvlive/util/ReplayCleanupScript.kt");
const PAGE = path.join(ROOT, "tools/probe_out/play_embed.html");
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

// ── 资源与残留防护（重要）──────────────────────────────────────
// 背景：清理脚本曾被自己的 mutation 死循环把无头 Chrome 主线程钉死（CPU 100%），
//       且 Ctrl+C / 交互中断时 proc.kill() 只杀主进程、留下 renderer/gpu 子进程变成孤儿。
//       子进程命令行里【没有】headless/tmp-chrome 字样，按名字过滤杀不掉 —— 必须【连树杀】。
// 这里加三重保险：看门狗超时 / 信号中断 / 正常结束，任一路径都强制杀掉整棵 Chrome 进程树。
var procRef = null;
function killTree() {
  if (!procRef) return;
  try { procRef.kill("SIGKILL"); } catch (e) {}
  try {
    // Windows：taskkill /T 会连子孙进程一起杀（这是清掉 renderer/gpu 孤儿进程的关键）
    require("child_process").spawn("taskkill", ["/T", "/F", "/PID", String(procRef.pid)], { stdio: "ignore" });
  } catch (e) {}
}
function bail(code) { killTree(); try { process.exit(code); } catch (e) {} }
// 看门狗：45 秒还没跑完，直接杀树退出，避免卡死空转占用 CPU
var watchdog = setTimeout(function () { console.error("  ⏱ 看门狗触发（>45s），强制结束并清理 Chrome"); bail(2); }, 45000);
try { watchdog.unref(); } catch (e) {}
// 被 Ctrl+C / 终端关闭 / 异常打断时，也要清理，绝不留残留
["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].forEach(function (s) {
  try { process.on(s, function () { console.error("\n  收到 " + s + "，清理 Chrome 后退出"); bail(3); }); } catch (e) {}
});
process.on("uncaughtException", function (e) { console.error("未捕获异常：", e); bail(1); });

(async function main() {
  // 启动时清掉历史遗留的浏览器临时目录
  try {
    fs.readdirSync(ROOT)
      .filter((n) => n.startsWith(".tmp-chrome-"))
      .forEach((n) => { try { fs.rmSync(path.join(ROOT, n), { recursive: true, force: true }); } catch (e) {} });
  } catch (e) {}

  // ── 第一步：从 Kotlin 提取清理脚本并校验语法 ────────────────────
  console.log("\n[1] 从 ReplayCleanupScript.kt 提取注入脚本并校验语法");
  const ktSrc = fs.readFileSync(KT, "utf8");
  const m = ktSrc.match(/"""\n([\s\S]*?)\n"""\s*\.trimIndent\(\)/);
  if (!m) { console.log("  ❌ 未能提取脚本字面量"); process.exit(1); }
  const verMatch = ktSrc.match(/VERSION\s*=\s*(\d+)/);
  const VERSION = verMatch ? Number(verMatch[1]) : 1;
  const cleanupJs = m[1].replace(/\$VERSION/g, String(VERSION));
  console.log("  提取到脚本 " + cleanupJs.length + " 字节，VERSION=" + VERSION);
  let syntaxOk = true;
  try { new Function(cleanupJs); } catch (e) { syntaxOk = false; console.log("  ❌ 语法错误：" + e.message); }
  ok("清理脚本语法合法（new Function 通过）", syntaxOk);
  if (!syntaxOk) { console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项"); process.exit(1); }

  // ── 第二步：无头 Chrome 加载真实详情页并注入 ───────────────────
  console.log("\n[2] 无头 Chrome 加载真实详情页 " + path.basename(PAGE) + " 并注入清理脚本");
  const chrome = CHROME_CANDIDATES.find((c) => { try { return fs.existsSync(c); } catch (e) { return false; } });
  if (!chrome) { console.log("  ❌ 找不到 Chrome/Edge"); process.exit(1); }
  console.log("  使用浏览器：" + chrome);

  const userDir = path.join(ROOT, ".tmp-chrome-" + Date.now());
  const proc = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--remote-debugging-port=0", "--user-data-dir=" + userDir,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
    "--disable-features=Translate,TranslateUI,BackForwardCache,site-per-process",
    "--window-size=800,600",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  procRef = proc;   // 交给 killTree() 兜底，任何退出路径都能连树杀掉

  let wsUrl = null;
  proc.stderr.on("data", (buf) => {
    const s = buf.toString();
    const mm = s.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (mm) wsUrl = mm[1];
  });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.log("  ❌ 无头浏览器未就绪"); bail(1); }

  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const page = list.find((t) => t.type === "page");
  const sock = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws 连接失败")); });

  let msgId = 0; const pend = new Map();
  sock.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
  };
  const send = (method, params) => new Promise((res) => { const id = ++msgId; pend.set(id, res); sock.send(JSON.stringify({ id, method, params: params || {} })); });
  const evalJs = async (expr, ms) => {
    let raw;
    try {
      raw = await Promise.race([
        send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("eval 超时")), ms || 8000)),
      ]);
    } catch (e) { return { err: e.message }; }
    if (raw && raw.result && raw.result.exceptionDetails) return { err: raw.result.exceptionDetails.text };
    return raw && raw.result && raw.result.result ? raw.result.result.value : undefined;
  };

  // 把详情页里的「阻塞式外部 <script src=https://…> / <link href=https://…>」剥离后再加载，
  // 否则沙箱无网络时这些请求会卡住 HTML 解析、连 CDP 求值都挂起。
  // 广告 DOM（.banner_ / .anchor_banner / #adFrame）和播放器/播放列表都是静态 HTML，与站外脚本无关，剥离不影响断言。
  const rawHtml = fs.readFileSync(PAGE, "utf8");
  const sane = rawHtml
    .replace(/<script\b[^>]*\bsrc=["']https?:\/\/[^"']*["'][^>]*>\s*<\/script>/gi, "")
    .replace(/<link\b[^>]*\bhref=["']https?:\/\/[^"']*["'][^>]*>/gi, "");
  const sanePath = path.join(ROOT, ".tmp-cleanup-page.html");
  fs.writeFileSync(sanePath, sane);

  await send("Page.enable");
  await send("Runtime.enable");
  const fileUrl = "file:///" + sanePath.replace(/\\/g, "/");
  await send("Page.navigate", { url: fileUrl });
  await sleep(1500);   // 等页面解析完（外部 CSS 已剥离，DOM 结构即时可用）

  // 清理前的基线计数
  const before = await evalJs(`(function(){
    return {
      banner: document.querySelectorAll('a.banner_, .banner_').length,
      anchor: document.querySelectorAll('.anchor_banner').length,
      adFrame: document.querySelectorAll('#adFrame').length,
      viewIframe: document.querySelectorAll('#view_iframe').length,
      playlist: document.querySelectorAll('.play-box-side-main').length,
      playBox: document.querySelectorAll('.play-box').length
    };
  })()`);
  console.log("  清理前：banner=" + before.banner + " anchor=" + before.anchor + " adFrame=" + before.adFrame +
    " viewIframe=" + before.viewIframe + " playlist=" + before.playlist + " playBox=" + before.playBox);
  ok("清理前详情页确实带广告（banner>0 或 anchor>0 或 adFrame>0）—— 证明样本真实",
    before.banner > 0 || before.anchor > 0 || before.adFrame > 0,
    "banner=" + before.banner + " anchor=" + before.anchor + " adFrame=" + before.adFrame);
  ok("清理前播放器 #view_iframe 存在（样本有效）", before.viewIframe >= 1, "viewIframe=" + before.viewIframe);
  ok("清理前播放列表 .play-box-side-main 存在（样本有效）", before.playlist >= 1, "playlist=" + before.playlist);

  // 注入清理脚本
  await evalJs(cleanupJs);
  await sleep(900);   // 让 MutationObserver + 首轮定时清理跑起来

  const after = await evalJs(`(function(){
    return {
      banner: document.querySelectorAll('a.banner_, .banner_').length,
      anchor: document.querySelectorAll('.anchor_banner').length,
      adFrame: document.querySelectorAll('#adFrame').length,
      viewIframe: document.querySelectorAll('#view_iframe').length,
      playlist: document.querySelectorAll('.play-box-side-main').length,
      playBox: document.querySelectorAll('.play-box').length,
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
      sideHidden: (function(){var s=document.querySelector('.t-p-side');return s?getComputedStyle(s).display:'none';})(),
      clean: !!window.__tvClean
    };
  })()`);
  console.log("  清理后：banner=" + after.banner + " anchor=" + after.anchor + " adFrame=" + after.adFrame +
    " viewIframe=" + after.viewIframe + " playlist=" + after.playlist + " 文档高=" + after.scrollH + "/" + after.clientH +
    " 侧栏display=" + after.sideHidden);

  ok("顶部广告块 .anchor_banner 已移除", after.anchor === 0, "剩余 " + after.anchor);
  ok("广告链接 .banner_ 已移除", after.banner === 0, "剩余 " + after.banner);
  ok("盖屏广告 iframe #adFrame 已移除", after.adFrame === 0, "剩余 " + after.adFrame);
  ok("播放器 #view_iframe 未被误删", after.viewIframe >= 1, "viewIframe=" + after.viewIframe);
  ok("播放列表 .play-box-side-main 未被误删", after.playlist >= 1, "playlist=" + after.playlist);
  ok("清理脚本已挂上 window.__tvClean", after.clean === true);
  ok("详情页左侧栏 .t-p-side 已隐藏（只留播放器+播放列表）", after.sideHidden === "none", "display=" + after.sideHidden);
  ok("整页变为可滚动（scrollHeight > clientHeight）—— 红点贴边滚动才能滚出下方内容",
    after.scrollH > after.clientH + 50, after.scrollH + " > " + after.clientH);

  // ── 第三步：延迟广告也会被清掉（确定性：追加后立即调用清理函数）──
  console.log("\n[3] 延迟注入的广告是否也会被清掉");
  const late = await evalJs(`(function(){
    try {
      var a = document.createElement('a');
      a.className = 'banner_';
      a.href = 'https://evil-bet.example/banner_click?id=999';
      a.innerHTML = '<img src="x.png">';
      (document.body || document.documentElement).appendChild(a);
      if (window.__tvClean && window.__tvClean.clean) window.__tvClean.clean();
      return document.querySelectorAll('a.banner_, .banner_').length;
    } catch (e) { return { err: String((e && e.message) || e) }; }
  })()`);
  ok("动态追加的 .banner_ 广告被清理函数清掉", late === 0,
    "剩余 " + late + (late && late.err ? " 错误=" + late.err : "（若超时说明主线程仍被 mutation 循环钉死）" ));

  // 收尾：先杀整棵 Chrome 进程树（防孤儿），再删临时目录
  killTree();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(sanePath, { force: true }); } catch (e) {}
  console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("运行异常：", e); process.exit(1); });
