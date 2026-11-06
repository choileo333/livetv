/**
 * 回放页「红点鼠标光标」脚本验证器
 * ─────────────────────────────────────────────────────────────
 * 目的：TvNavScript.kt 里注入的 JS 是字符串，编译期查不出语法/逻辑错误，
 *      一旦写错，只能等用户真机操作时才发现（而那时看到的现象只是"没反应"，
 *      极难定位）。故这里做三件事：
 *        1) 从 Kotlin 源码里把 JS 抠出来，用 new Function 校验语法 + 静态自检关键点；
 *        2) 在无头 Chrome 里造一个模拟回放站页面，真实注入脚本、真实派发按键，
 *           验证红点真的会动、按确定真的能点中目标元素（用页面回执证明）；
 *        3) 核对 Kotlin/布局侧真的按用户要求精简了控制条（只留全屏）。
 *
 * 用法：node tools/verify_tvnav.js
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const KT = path.join(ROOT, "app/src/main/java/com/leo/tvlive/util/TvNavScript.kt");
const ACTIVITY = path.join(ROOT, "app/src/main/java/com/leo/tvlive/ui/MainActivity.kt");
const LAYOUT_PORT = path.join(ROOT, "app/src/main/res/layout/activity_main.xml");
const LAYOUT_LAND = path.join(ROOT, "app/src/main/res/layout-land/activity_main.xml");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

// 启动前先清掉历史遗留的浏览器临时目录。
// （上一轮的 rmSync 常因 Chrome 尚未完全退出、文件仍被占用而失败，
//   所以不能只依赖「结束时删」，还要在「开始时清」。）
try {
  fs.readdirSync(ROOT)
    .filter((n) => n.startsWith(".tmp-chrome-"))
    .forEach((n) => { try { fs.rmSync(path.join(ROOT, n), { recursive: true, force: true }); } catch (e) {} });
} catch (e) {}

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log("  ✅ " + n + (extra ? "  —— " + extra : "")); }
  else { fail++; console.log("  ❌ " + n + (extra ? "  —— " + extra : "")); }
};

// ── 第一步：从 Kotlin 源码里提取 JS 并校验语法 ────────────────────
console.log("\n[1] 从 TvNavScript.kt 提取注入脚本并校验语法");
const ktSrc = fs.readFileSync(KT, "utf8");
const m = ktSrc.match(/"""\n([\s\S]*?)\n"""\s*\.trimIndent\(\)/);
if (!m) {
  console.log("  ❌ 未能从 Kotlin 源码中提取到脚本字面量");
  process.exit(1);
}
// Kotlin raw string 里的 $VERSION 是编译期插值，这里按常量值还原
const verMatch = ktSrc.match(/VERSION\s*=\s*(\d+)/);
const VERSION = verMatch ? Number(verMatch[1]) : 3;
const js = m[1].replace(/\$VERSION/g, String(VERSION));
console.log("  提取到脚本 " + js.length + " 字节，VERSION=" + VERSION + "（Kotlin 源码里为 $VERSION，编译期插值）");

let syntaxOk = true, syntaxErr = "";
try { new Function(js); } catch (e) { syntaxOk = false; syntaxErr = e.message; }
ok("注入脚本语法正确（可被 JS 引擎解析）", syntaxOk, syntaxErr);

// 静态自检：确认关键接口与关键字都在
ok("暴露了 window.__tvNav 接口", /window\.__tvNav\s*=/.test(js));
ok("实现了 19/20/21/22 方向键分发", [19, 20, 21, 22].every((c) => js.includes("code === " + c)));
ok("实现了 23/66 确定键分发", js.includes("code === 23") && js.includes("code === 66"));
ok("复用同一脚本时不会重复挂载（有版本号短路）", /nav\.version === /.test(js));
ok("红点是圆形红点（不是原来的矩形选框）", /border-radius:50%/.test(js) && /background:#FF3B30/.test(js));
ok("红点用固定定位 + 最大 z-index（不会被页面内容盖住）", /position:fixed/.test(js) && /2147483647/.test(js));
ok("红点自身不吃事件（pointer-events:none），否则命中测试永远只能点到它",
  /pointer-events:none/.test(js));
ok("用浏览器原生命中测试定位目标元素（elementFromPoint）", /elementFromPoint/.test(js));
ok("用原生 click() 触发默认行为（合成事件不会跳转链接）", /\.click\(\)/.test(js));
ok("会补发鼠标事件（mousemove/mouseover/mousedown/mouseup）",
  ["mousemove", "mouseover", "mousedown", "mouseup"].every((k) => js.includes("'" + k + "'")));
ok("同源 iframe 会下钻（跨域 iframe 无法进入，属已知边界）", /contentDocument/.test(js) && /IFRAME/.test(js));
ok("会钻进同源 iframe 找视频（回放站的播放器就在同源 iframe 内）", /findVideoCenter/.test(js));
ok("红点贴到视口边缘后会滚动页面（长页面/长列表必需）",
  /function tryScroll/.test(js) && /window\.scrollBy/.test(js));
ok("滚动覆盖老内核：scrollingElement / documentElement / body 三个候选都试",
  /scrollingElement/.test(js) && /doc\.documentElement/.test(js) && /doc\.body/.test(js));
ok("滚动按「由内到外」接力：先滚红点所在的内部容器，滚到头再滚整页",
  /scrollNode\(node, dx, dy\)/.test(js) && /scrollDocRoot\(document, dx, dy\)/.test(js));
ok("「贴边判定带」与「硬边界」是两个常量（滚到头时红点仍能贴边够到边缘内容）",
  /var BAND = 36/.test(js) && /var HARD = 8/.test(js));
ok("有几何兜底扫描（滚动容器不是红点祖先的少见结构也能滚）", /scanScrollable/.test(js));
ok("暴露 reset/paint 供原生层重复注入时刷新", /reset: reset/.test(js) && /paint: paint/.test(js));

// v1.3.0：诊断上报 + 黑屏自愈（电视端黑屏、手机正常 → 必须先把「为什么」带出来）
ok("用 console.log + __TVNAV__ 前缀向原生层做单向上报（不额外挂 JS 桥，老 WebView 也稳）",
  /__TVNAV__/.test(js) && /console\.log/.test(js));
ok("上报本机播放能力（MSE / 原生 HLS / mp4 / hls 库）",
  /function caps/.test(js) && /MediaSource/.test(js) && /application\/vnd\.apple\.mpegurl/.test(js));
ok("有黑屏自愈巡检（页面里有 video 却没在播 → 替用户按一次播放）",
  /function watchdog/.test(js) && /v\.play\(\)/.test(js));
ok("自愈有 20 秒窗口限制（之后不再干预，免得把用户主动的暂停又播回来）",
  /WATCH_MS = 20000/.test(js));
ok("自愈接住了 play() 返回的 Promise 拒绝（不接就是静默失败 —— 黑屏查不出的根因）",
  /pr\.catch/.test(js) && /自动播放被拒/.test(js));
ok("起播 8 秒后仍找不到 video 元素会主动上报（播放器整块没渲染出来）", /t > 8000/.test(js));
ok("「video 怎么了」被拆成三种文案：真没有 / 有但没显示 / 有可见但没在播（一句笼统话会把排查带偏）",
  /页面里没有 video 元素/.test(js) && /但全部没显示/.test(js) && /但都还没开始播/.test(js));
ok("暴露 diag / watchOnce 供原生层与自动化验证使用",
  /diag: function/.test(js) && /watchOnce: function/.test(js));

// ── 第二步：核对 Kotlin / 布局侧的精简（用户要求：只留全屏） ──────
console.log("\n[2] 核对控制条精简：只保留「全屏 / 退出全屏」");
const actSrC = fs.readFileSync(ACTIVITY, "utf8");
const layPort = fs.readFileSync(LAYOUT_PORT, "utf8");
const layLand = fs.readFileSync(LAYOUT_LAND, "utf8");
ok("竖屏布局仍有 btn_ctrl_full", layPort.includes('android:id="@+id/btn_ctrl_full"'));
ok("横屏布局仍有 btn_ctrl_full", layLand.includes('android:id="@+id/btn_ctrl_full"'));
ok("竖屏布局已删除 btn_ctrl_play / btn_ctrl_mute",
  !layPort.includes('android:id="@+id/btn_ctrl_play"') && !layPort.includes('android:id="@+id/btn_ctrl_mute"'));
ok("横屏布局已删除 btn_ctrl_play / btn_ctrl_mute",
  !layLand.includes('android:id="@+id/btn_ctrl_play"') && !layLand.includes('android:id="@+id/btn_ctrl_mute"'));
ok("MainActivity 不再引用 btnCtrlPlay / btnCtrlMute",
  !actSrC.includes("btnCtrlPlay") && !actSrC.includes("btnCtrlMute"));
ok("MainActivity 不再有 muted 静音状态", !/\bmuted\b/.test(actSrC.replace(/\/\/.*/g, "")));
ok("确定键「长按 = 切全屏」已实现（方向键被网页接管后，全屏按钮无法用遥控器聚焦）",
  /OK_LONG_PRESS_MS/.test(actSrC) && /okLongPressTask/.test(actSrC) && /toggleFullscreen\(\)/.test(actSrC));
ok("菜单键也能切全屏", /KEYCODE_MENU/.test(actSrC));
ok("回放模式按返回会先让网页后退（否则用户会被困在播放页）", /canGoBack\(\)/.test(actSrC));
ok("回放提示条说明了「后退/回直播」", layPort.includes("后退") && layLand.includes("后退"));

// ── v1.4.4：回看页五处细节改动的静态自检 ──
ok("红点步长已调细（用户反馈「有些按钮按不到」）",
  /vw\(\) \* 0\.04/.test(js) && /vh\(\) \* 0\.045/.test(js));
ok("贴边滚动步长独立于红点步长（瞄准细、翻页不慢）",
  /function scrollStepX/.test(js) && /scrollStepX\(\)/.test(js) && /function scrollStepY/.test(js));
ok("注入脚本暴露 repaint（全屏后红点原位重对齐）", /repaint: repaint/.test(js) && /function repaint/.test(js));
ok("resize 后延迟二次重绘（等布局稳定，治「全屏返回后定位不准」）", /setTimeout\(paint, 320\)/.test(js));
ok("原生层在全屏切换后主动调用 __tvNav.repaint", /repaintNavSoon/.test(actSrC) && /__tvNav\.repaint/.test(actSrC));
ok("注入脚本维护「后退栈」并上报深度（治「返回直接回直播」）",
  /var navStack/.test(js) && /report\('nav'/.test(js));
ok("注入脚本暴露 back()，原生返回键优先调用它",
  /back: back/.test(js) && /webNavDepth/.test(actSrC) && /__tvNav\.back/.test(actSrC));
ok("注入脚本可清理旧实例（dispose，防新旧脚本打架致回看页错乱）",
  /dispose: function/.test(js) && /nav\.dispose/.test(js));
ok("注入脚本能识别「工作空间已停止」占位页并上报 stopped",
  js.indexOf("工作空间已停止") >= 0 && /report\('stopped'/.test(js));
ok("原生层收到 stopped 会自动重载唤醒（限次）", /onHostStopped/.test(actSrC) && /hostStoppedRetries/.test(actSrC));

// ── 第二步之二：核对 App 侧的网页诊断能力（v1.3.0）──────────────
// 这一节是本次改动的核心：在此之前 App 对网页里发生的一切完全无感，
// 「黑屏」只能靠用户口头描述，根因无从查起。
console.log("\n[2b] 核对 App 侧的网页诊断与崩溃恢复能力");
ok("捕获网页 JS 错误（onConsoleMessage）", /override fun onConsoleMessage/.test(actSrC));
ok("识别注入脚本的上报前缀（DIAG_PREFIX 与脚本里的字符串一致）",
  /DIAG_PREFIX/.test(actSrC) && actSrC.includes('"__TVNAV__"') && js.includes("__TVNAV__"));
ok("捕获主文档加载失败（onReceivedError）", /override fun onReceivedError/.test(actSrC));
ok("捕获 HTTP 层被拒（onReceivedHttpError，防盗链失败大多长这样）",
  /override fun onReceivedHttpError/.test(actSrC));
ok("处理网页渲染进程被回收（onRenderProcessGone）", /override fun onRenderProcessGone/.test(actSrC));
ok("渲染进程崩溃时返回 true（返回 false 会让系统连带杀掉整个应用）",
  /onRenderProcessGone[\s\S]{0,1400}?return true/.test(actSrC));
ok("崩溃后会在原位重建 WebView（已死的 WebView 重新加载是没用的）",
  /private fun rebuildWebView/.test(actSrC) && /webView\.destroy\(\)/.test(actSrC));
// v1.4.4：按用户要求「网页上的警告信息不显示」，诊断不再上屏、只写 logcat；红点位置提示保留。
ok("诊断采集能力仍在（pushDiag）", /private fun pushDiag/.test(actSrC));
ok("网页警告不再回显到状态行（v1.4.4：用户要求去掉屏上警告）",
  !/tvStatus\.text = "⚠ /.test(actSrC));
ok("网页警告不再覆盖回放提示条（v1.4.4）", !/tvReplayHint\.text = "⚠ /.test(actSrC));
ok("诊断改写入 logcat（tag=TvLive），需要时仍可取", /Log\.w\("TvLive"/.test(actSrC));
ok("红点「位置提示」保留（__tvnav_tip + paintTip，用户明确要求保留）",
  js.indexOf("__tvnav_tip") >= 0 && /function paintTip/.test(js));
// ── v1.4.0：诊断显示「根因优先」+ 能力上报带内核版本 ──
ok("诊断按「根因优先」挑显示项（JS 异常/失败原因优先于泛泛的现象描述）",
  /SEVERE_RE/.test(actSrC) && /firstOrNull \{ SEVERE_RE/.test(actSrC));
ok("诊断显示带总条数（连环故障一眼可见，不会被最后一条盖掉）",
  /共 \$\{webDiag\.size\} 条/.test(actSrC));
ok("能力上报里带了网页内核版本（区分「设备太老」与「我们代码错」的关键证据）",
  /kernel=/.test(js) && /kernel=Chrome\//.test(actSrC));
ok("内核过旧会单独报出来（站点播放器用的新库跑不动就是它）",
  /OLD_KERNEL_MAX/.test(actSrC) && /网页内核过旧/.test(actSrC));
ok("「找不到 video」被细分成三种情况（真没有 / 有但被隐藏 / 有但没在播）",
  /function videoDiag/.test(js) && /被隐藏或尺寸为 0/.test(js) && /还没开始播/.test(js));
ok("每次翻页会清空上一轮诊断（否则「共 N 条」会把旧错误算进来）",
  /webDiag\.clear\(\)/.test(actSrC));

// ── v1.4.1：反调试三层防御（站点有两套以上反调试，且其中一套是拦不掉的 inline 脚本）──
console.log("\n[2b-1] 反调试加固（MainActivity）");
ok("防御①拦掉反调试脚本文件（shouldInterceptRequest 返回空 JS）",
  /override fun shouldInterceptRequest/.test(actSrC) && /ANTI_DEBUG_RE\.containsMatchIn/.test(actSrC));
ok("防御②关掉网页缓存：缓存命中不产生请求 ⇒ 拦截回调不触发 ⇒ 拦截会「时灵时不灵」",
  /cacheMode = WebSettings\.LOAD_NO_CACHE/.test(actSrC));
ok("防御③拦住「跳错误页」的导航（toDevtools() 是 inline 脚本，请求层拦不掉，只能拦它的跳转）",
  /ERROR_PAGE_RE/.test(actSrC) && /override fun shouldOverrideUrlLoading/.test(actSrC) &&
  /error0/.test(actSrC) && /live_error/.test(actSrC));
ok("onPageStarted 就注入（onPageFinished 要等整页加载完，那时反调试脚本早跑完了）",
  /override fun onPageStarted/.test(actSrC) && /evaluateJavascript\(ReplayRescueScript\.JS/.test(actSrC));
ok("拦截「跳错误页」时会如实上报给用户（不静默吞掉）",
  /拦截跳转/.test(actSrC));

// ── v1.4.0：播放器兜底脚本（ReplayRescueScript）────────────────
console.log("\n[2b] 播放器兜底脚本 ReplayRescueScript.kt 自检");
const rescueKt = fs.readFileSync(path.join(ROOT, "app/src/main/java/com/leo/tvlive/util/ReplayRescueScript.kt"), "utf8");
const rm = rescueKt.match(/"""\n([\s\S]*?)\n"""\s*\.trimIndent\(\)/);
if (!rm) {
  console.log("  ❌ 未能从 ReplayRescueScript.kt 提取到脚本字面量");
  process.exit(1);
}
const rjs = rm[1].replace(/\$VERSION/g, String((rescueKt.match(/VERSION\s*=\s*(\d+)/) || [])[1] || 1));
let rSynOk = true, rSynErr = "";
try { new Function(rjs); } catch (e) { rSynOk = false; rSynErr = e.message; }
ok("兜底脚本语法正确（可被 JS 引擎解析）", rSynOk, rSynErr);
// 严格 ES5：老电视盒子的 WebView 解析不了箭头函数/let/const/模板字符串，写了就等于没写。
// 注意必须先剥掉注释再扫 —— 注释里写「站点形如 ...m3u8」这种省略号会被误判成展开运算符。
const rjsCode = rjs
  .replace(/\/\*[\s\S]*?\*\//g, " ")   // 去掉块注释
  .replace(/^\s*\/\/.*$/gm, " ")       // 去掉整行注释
  .replace(/([^:"'])\/\/[^\n'"]*$/gm, "$1 ");   // 去掉行尾注释（避开字符串里的 //）
const es6 = [
  ["箭头函数", /=>/],
  ["let 声明", /\blet\s/],
  ["const 声明", /\bconst\s/],
  ["模板字符串", /`/],
  ["展开运算符", /\.\.\./],
].filter(([, re]) => re.test(rjsCode)).map(([n]) => n);
ok("只用 ES5 语法（老 WebView 才跑得起来）", es6.length === 0, es6.length ? "发现：" + es6.join("/") : "无 ES6+ 语法");
ok("复用同一脚本时不会重复挂载（有版本号短路）", /__tvRescue && window\.__tvRescue\.version === V/.test(rjs));
ok("只在站点播放器「没起来」时才动手（有能播的 video 就绝不打扰）",
  /function aliveVideo/.test(rjs) && /if \(aliveVideo\(document, 0\)\) return;/.test(rjs));
ok("有耐心窗口（GRACE_MS）与总时限（STOP_MS），不会无限重试拖死盒子",
  /GRACE_MS = \d+/.test(rjs) && /STOP_MS = \d+/.test(rjs) && /clearInterval\(timer\)/.test(rjs));
ok("取真实流地址：读同源 iframe 的 window.vid（iframe src 里那串 pop/xxx.m3u8 是失效入口，恒 404）",
  /function readVid/.test(rjs) && /frame\.win && frame\.win\.vid/.test(rjs));
ok("window.vid 读不到时，自己会复刻 common.js 的 base64+XOR 解密从 HTML 里算出 vid",
  /function decodeVidFromHtml/.test(rjs) && /function base64Decode/.test(rjs) && /function xorKey/.test(rjs) &&
  /extractVar\(html, 'phpsiteEc2'\)/.test(rjs) && /extractVar\(html, 'phpsitekey3'\)/.test(rjs));
ok("严格判定「这串本身是不是 m3u8」（pathname 以 .m3u8 结尾，不再用 indexOf 误判查询参数）",
  /function isM3u8/.test(rjs) && rjs.includes("\\.m3u8$/i.test(s)") && !/indexOf\('\.m3u8'\)/.test(rjsCode));
ok("Referer 取「播放器页自己的 origin」（实测流服务器只认它，送别的域一律 404）",
  /function refOf/.test(rjs) && /new URL\(inner \|\| raw/.test(rjs));
ok("每轮巡检都把 vid 记下来（播放器 iframe 之后被清空也救得回来）",
  /function walkVid/.test(rjs) && /if \(info\) lastStream = info;/.test(rjs));
ok("流地址走本后端中继并带上播放器 Referer（绕开防盗链，这是播不出来的关键）",
  /\/api\/relay\?url=/.test(rjs) && /&ref=/.test(rjs) && /raw=1/.test(rjs));
ok("优先复用播放器页里已加载好的 hls.js（0.14.17，ES5，老内核也能跑）",
  /var Hs = w\.Hls/.test(rjs));
ok("播放器页没有 hls.js 时，从本后端同源加载 /hls.min.js（ES5 压缩版）",
  /s\.src = '\/hls\.min\.js'/.test(rjs));
ok("本机没有 MSE 时退化成系统原生 HLS（老内核反而可能支持这个）",
  /function nativeOrTell/.test(rjs) && /canPlayType\('application\/vnd\.apple\.mpegurl'\)/.test(rjs));
ok("自建的播放器强制定位/尺寸（站点播放器建不出来时容器高度是 0，不撑开就看不见）",
  /__tvrescue_video/.test(rjs) && /z-index:11/.test(rjs) && /box\.style\.height = H \+ 'px'/.test(rjs));
ok("幂等：重复调用不会叠加出多个播放器", /removeChild\(old\)/.test(rjs));
ok("广告遮罩兜底只在站点自己的倒计时失效后才做（GATE_MS > 站点自己的 6 秒）",
  /GATE_MS = \d+/.test(rjs) && Number((rjs.match(/GATE_MS = (\d+)/) || [])[1] || 0) > 6000);
ok("广告遮罩兜底用 !important 压过站点样式（否则站点脚本可能又设回去）",
  /display:block !important/.test(rjs) && /display:none !important/.test(rjs));
ok("兜底结果会上报给原生层（成功/失败都要能看见，不能静默）",
  /report\('rescue'/.test(rjs) && /report\('gate'/.test(rjs));
ok("MainActivity 在回放模式注入了兜底脚本", /ReplayRescueScript\.JS/.test(actSrC) && /MODE_REPLAY\) view\?\.evaluateJavascript\(ReplayRescueScript/.test(actSrC));
ok("原生层识别 rescue/gate 两类上报", /startsWith\("rescue "\)/.test(actSrC) && /startsWith\("gate "\)/.test(actSrC));

// ── 第三步：无头 Chrome 里真实跑一遍红点光标 ─────────────────────
console.log("\n[3] 无头 Chrome 真实注入 + 真实按键");

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.log("  ⚠️  未找到 Chrome/Edge，跳过真实运行验证（语法与静态自检已完成）");
  console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail ? 1 : 0);
}
console.log("  使用浏览器：" + chrome);

// 模拟回放站外层页面。
// 元素统一 position:fixed（不随滚动漂移），真实坐标在页面加载后由测试脚本按视口算出，
// 目的是让它们精确落在「红点键盘可达的格点」上，从而能用真实按键走到并点击。
// iframe 刻意不写死在 HTML 里：初始位置的断言必须在「页面里没有视频/iframe」时做，
// 之后再动态创建，才能分别验证「空页面落正中」与「有视频落到视频上」两条路径。
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{margin:0;background:#111;color:#eee;font:14px sans-serif}
  .btn{position:fixed;width:160px;height:80px;background:#e53935;border-radius:8px;
       display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff}
  #hoverbox{position:fixed;width:160px;height:80px;background:#2b6cb0;border-radius:8px;
       display:flex;align-items:center;justify-content:center;color:#fff}
  iframe{position:fixed;border:0;background:#333}
  #log{position:fixed;left:8px;bottom:8px;color:#7f7;font:12px monospace}
  #spacer{position:absolute;left:0;top:0;width:10px;height:4000px}
</style></head>
<body>
<div class="btn" id="b_center">CENTER</div>
<div class="btn" id="b_right">RIGHT</div>
<div id="hoverbox">HOVER</div>
<div id="log">log=</div>
<div id="spacer"></div>
<script>
  var stats = { over: 0, move: 0 };
  var hb = document.getElementById('hoverbox');
  hb.addEventListener('mouseover', function(){ stats.over++; });
  hb.addEventListener('mousemove', function(){ stats.move++; });
  hb.addEventListener('click', function(){ document.getElementById('log').textContent = 'HOVER-CLICK'; });
  document.getElementById('b_center').addEventListener('click', function(){ document.getElementById('log').textContent = 'CENTER'; });
  document.getElementById('b_right').addEventListener('click', function(){ document.getElementById('log').textContent = 'RIGHT'; });
  window.__stats = stats;
  // 造一个同源 iframe 放到指定格点上（供「下钻点击」与「钻进 iframe 找视频」两条测试用）
  window.__makeFrame = function(id, src, cx, cy, w, h){
    var f = document.createElement('iframe');
    f.id = id; f.src = src;
    f.style.width = w + 'px'; f.style.height = h + 'px';
    f.style.left = (cx - w / 2) + 'px'; f.style.top = (cy - h / 2) + 'px';
    document.body.appendChild(f);
    return f;
  };
</script>
</body></html>`;

// iframe 内层页面（同源）：① 只有一个按钮，用于验证「下钻后能真正点到」；
// ② 只有一个 video，用于验证「初始落点会钻进 iframe 找到视频中心」。
// 真实回放站正是这个样子：播放器放在 /api/embed?url=... 的同源 iframe 里。
const INNER_BTN = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden}
  button{display:block;width:100%;height:100%;font:14px sans-serif;background:#f6ad55;border:0}
</style></head><body>
<button id="ib" onclick="window.parent.__iframeClicked=true">INNER</button>
</body></html>`;

// video 必须 display:block：行内元素会留基线空隙并撑出 iframe 滚动条，
// 那样内层视频的中心就会偏离 iframe 中心（第一次跑这个用例时差了 7px，就是滚动条吃了宽度）。
const INNER_VIDEO = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden}
  video{display:block;width:100%;height:100%;background:#000}
</style></head><body>
<video id="iv"></video>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (req.url.startsWith("/inner-btn")) res.end(INNER_BTN);
  else if (req.url.startsWith("/inner-video")) res.end(INNER_VIDEO);
  else res.end(PAGE);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 资源与残留防护（与 verify_cleanup.js 同款）─────────────────
// 无头 Chrome 曾因被测脚本的死循环被钉在 100% CPU，交互中断时还会留下 renderer 子进程孤儿
// （子进程命令行不含 headless，按名字杀不掉，必须【连树杀】）。任何退出路径都要清干净。
var procRef = null;
function killTree() {
  if (!procRef) return;
  try { procRef.kill("SIGKILL"); } catch (e) {}
  try {
    require("child_process").spawn("taskkill", ["/T", "/F", "/PID", String(procRef.pid)], { stdio: "ignore" });
  } catch (e) {}
}
function bail(code) { killTree(); try { process.exit(code); } catch (e) {} }
var watchdog = setTimeout(function () { console.error("  ⏱ 看门狗触发（>90s），强制结束并清理 Chrome"); bail(2); }, 90000);
try { watchdog.unref(); } catch (e) {}
["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"].forEach(function (s) {
  try { process.on(s, function () { console.error("\n  收到 " + s + "，清理 Chrome 后退出"); bail(3); }); } catch (e) {}
});
process.on("uncaughtException", function (e) { console.error("未捕获异常：", e); bail(1); });

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = "http://127.0.0.1:" + port + "/";

  // Chrome 的临时用户目录放在工程内（遵循「不往 C 盘塞东西」的习惯），用完即删
  const userDir = path.join(ROOT, ".tmp-chrome-" + Date.now());
  const proc = spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--user-data-dir=" + userDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    "--window-size=1280,720",
    url,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  procRef = proc;   // 交给 killTree() 兜底

  // 从 stderr 里解析 DevTools 监听的端口
  let wsUrl = null;
  proc.stderr.on("data", (buf) => {
    const s = buf.toString();
    const mm = s.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (mm) wsUrl = mm[1];
  });

  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) {
    console.log("  ❌ 无头浏览器未就绪");
    try { server.close(); } catch (e) {}
    console.log("\n结果：通过 " + pass + " 项，失败 " + fail + " 项");
    bail(1);
  }

  // 连上页面 target
  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const page = list.find((t) => t.type === "page");

  // 直接用 Node 22 内置的 WebSocket（WHATWG 接口），不引入任何第三方依赖
  const sock = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws 连接失败")); });

  let msgId = 0;
  const pend = new Map();
  // 收集页面的 console 输出：注入脚本就是靠 console.log('__TVNAV__ ...') 向原生层上报诊断的，
  // 这里必须把这条通道也接住，才能验证「黑屏时 App 真的能收到原因」。
  const consoleLogs = [];
  sock.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description)).join(" ");
      consoleLogs.push(text);
    }
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++msgId;
    pend.set(id, res);
    sock.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await sleep(1400);   // 等页面加载完

  // 按视口把测试元素摆到「红点键盘可达的格点」上，并记录几何参数供断言使用
  const geom = await evalJs(`(function(){
    var vw = window.innerWidth, vh = window.innerHeight;
    var sx = Math.max(24, Math.round(vw * 0.04));   // 必须与脚本里的 stepX 公式一致（v1.4.4 调细）
    var sy = Math.max(20, Math.round(vh * 0.045));  // 必须与脚本里的 stepY 公式一致（v1.4.4 调细）
    var cx0 = Math.max(6, Math.min(vw - 6, Math.round(vw / 2)));
    var cy0 = Math.max(6, Math.min(vh - 6, Math.round(vh / 2)));
    function put(id, cx, cy){
      var e = document.getElementById(id);
      e.style.left = (cx - 80) + 'px';
      e.style.top  = (cy - 40) + 'px';
    }
    put('b_center', cx0, cy0);                              // 视口正中：0 次按键即可点到
    put('b_right',  cx0 + 3 * sx, cy0);                     // 右移 3 格
    put('hoverbox', cx0 - 3 * sx, cy0);                     // 左移 3 格
    return { vw: vw, vh: vh, sx: sx, sy: sy, cx0: cx0, cy0: cy0 };
  })()`);
  console.log("  视口 " + geom.vw + "x" + geom.vh + " · 步长 " + geom.sx + "/" + geom.sy +
              " · 初始落点 " + geom.cx0 + "," + geom.cy0);

  // 必须与 TvNavScript.kt 里的同名常量一致
  const BAND = 36;   // 贴边判定带宽度
  const HARD = 8;    // 硬边界（滚到头后红点最多贴到距边缘多少像素）

  // 注入脚本（与 App 里完全同一份代码路径）
  await evalJs(js);
  await sleep(300);

  const pos = () => evalJs("window.__tvNav.pos()");
  const hitId = () => evalJs("(function(){var p=window.__tvNav.pos();var e=document.elementFromPoint(p.x,p.y);return e?(e.id||e.tagName):null;})()");
  const key = async (code, wait) => { await evalJs("window.__tvNav.key(" + code + ")"); await sleep(wait || 120); };

  ok("脚本注入后 window.__tvNav 存在", (await evalJs("!!window.__tvNav")) === true);

  // ── 红点本身 ──
  const dotInfo = await evalJs(`(function(){
    var d = document.getElementById('__tvnav_dot');
    if (!d) return null;
    var s = window.getComputedStyle(d);
    var r = d.getBoundingClientRect();
    return { w: r.width, h: r.height, radius: s.borderRadius, bg: s.backgroundColor,
             fixed: s.position, pe: s.pointerEvents, z: s.zIndex };
  })()`);
  ok("页面上真的出现了红点元素", dotInfo !== null, dotInfo ? JSON.stringify(dotInfo) : "未找到");
  ok("红点是圆形（border-radius 50%）", dotInfo && /50%/.test(dotInfo.radius), dotInfo && dotInfo.radius);
  ok("红点是红色（rgb(255,59,48)）", dotInfo && /255,\s*59,\s*48/.test(dotInfo.bg), dotInfo && dotInfo.bg);
  ok("红点用 fixed 定位 + 顶层 z-index", dotInfo && dotInfo.fixed === "fixed" && Number(dotInfo.z) > 1000000,
    dotInfo && (dotInfo.fixed + " / " + dotInfo.z));
  ok("红点不吃事件（pointer-events:none）—— 否则命中测试永远点到它自己",
    dotInfo && dotInfo.pe === "none", dotInfo && dotInfo.pe);

  const p0 = await pos();
  ok("初始落点在视口正中（页面里没有视频时）", p0 && p0.x === geom.cx0 && p0.y === geom.cy0, JSON.stringify(p0));
  ok("红点位置不遮挡命中测试：该点命中的是页面元素而不是红点",
    (await hitId()) === "b_center", "命中=" + (await hitId()));

  // ══════════════════════════════════════════════════════════
  // [3b] 诊断上报与黑屏自愈（v1.3.0）
  // 电视端「黑屏、连播放按钮都没有」而手机正常 —— 排查的前提是先把「为什么」带出来。
  // ══════════════════════════════════════════════════════════
  console.log("\n[3b] 诊断上报与黑屏自愈（真实 console 通道 + 真实 video 元素）");
  const navUp = () => consoleLogs.filter((x) => x.indexOf("__TVNAV__") === 0);

  ok("注入后立即上报了本机播放能力（原生层据此判断是不是「设备根本播不了」）",
    navUp().some((x) => x.indexOf("__TVNAV__ caps ") === 0),
    navUp().slice(-3).join(" | ") || "（没有收到任何上报）");

  const capsLine = navUp().find((x) => x.indexOf("__TVNAV__ caps ") === 0) || "";
  ok("能力上报里含 mse / nativeHls / mp4 三项（黑屏归因全靠它）",
    capsLine.indexOf("mse=") > 0 && capsLine.indexOf("nativeHls=") > 0 && capsLine.indexOf("mp4=") > 0,
    capsLine);

  // 造一个「存在但没在播」的 video，并把 play() 换成可观测的桩：
  // 既能验证脚本确实替用户按了播放，又不会因为测试页没有真实媒体源而失败。
  await evalJs(`(function(){
    var v = document.createElement('video');
    v.id = 'wdvideo';
    v.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:100px;background:#000';
    window.__playCalled = false;
    v.play = function(){ window.__playCalled = true; return Promise.reject(new Error('no source in test')); };
    document.body.appendChild(v);
  })()`);
  await sleep(2800);   // 等自愈巡检跑一轮（脚本每 2.5 秒巡检一次）
  ok("页面里有 video 却一直没在播时，脚本会替用户按一次「播放」",
    (await evalJs("window.__playCalled === true")) === true);
  ok("play() 被拒时会带着原因上报（Promise 拒绝不再被静默吞掉 —— 这正是黑屏一直查不出的原因）",
    navUp().some((x) => x.indexOf("__TVNAV__ video 自动播放被拒") === 0),
    navUp().filter((x) => x.indexOf("__TVNAV__ video") === 0).slice(-2).join(" | ") || "（无）");

  // 把 video 整个移除，等累计超过 8 秒阈值 → 应上报「找不到 video 元素」
  await evalJs("(function(){var e=document.getElementById('wdvideo');if(e&&e.parentNode)e.parentNode.removeChild(e);})()");
  await sleep(5600);
  await evalJs("window.__tvNav.watchOnce()");   // 兜底手动跑一次（定时器可能刚好在这期间停了）
  await sleep(250);
  ok("起播 8 秒后页面里仍找不到 video 元素 → 主动上报（说明播放器整块没渲染出来）",
    navUp().some((x) => x.indexOf("__TVNAV__ video") === 0 && x.indexOf("没有 video 元素") > 0),
    navUp().filter((x) => x.indexOf("video") > 0).slice(-2).join(" | ") || "（无）");

  // 诊断期间动过 DOM，把红点复位 —— 后续断言都以 p0 为基准
  await evalJs("window.__tvNav.reset()");
  await sleep(150);

  // ── 方向键真的让红点位移（且步长与公式一致）──
  await key(22);
  const p1 = await pos();
  ok("按「右」红点右移一个步长", p1.x - p0.x === geom.sx && p1.y === p0.y,
    "Δx=" + (p1.x - p0.x) + "（期望 " + geom.sx + "）");

  await key(20);
  const p2 = await pos();
  ok("按「下」红点下移一个步长", p2.y - p1.y === geom.sy && p2.x === p1.x,
    "Δy=" + (p2.y - p1.y) + "（期望 " + geom.sy + "）");

  // ── 走到右侧按钮并按确定：验证「点击真的落到目标上」──
  await key(19);            // 上：回到同一行
  await key(22);            // 右：第 2 格
  await key(22, 200);       // 右：第 3 格（b_right 所在列）
  const p3 = await pos();
  ok("连续按键能把红点走到右侧按钮上",
    p3.x === geom.cx0 + 3 * geom.sx && p3.y === geom.cy0, JSON.stringify(p3));
  ok("红点下方确实是目标按钮", (await hitId()) === "b_right", "命中=" + (await hitId()));
  await key(23, 260);       // 确定
  const log1 = await evalJs("document.getElementById('log').textContent");
  ok("按确定键能真正点中按钮（页面收到点击）", log1 === "RIGHT", "页面回执='" + log1 + "'");

  // ── 走到左侧 hoverbox：验证悬停事件补发（很多播放器只在鼠标悬停时显示控制条）──
  for (let i = 0; i < 6; i++) await key(21, 80);
  await sleep(200);
  const p4 = await pos();
  ok("按「左」能一路走到左侧的悬停目标上",
    p4.x === geom.cx0 - 3 * geom.sx && p4.y === geom.cy0, JSON.stringify(p4));
  const st = await evalJs("window.__stats");
  ok("红点移上去时补发了 mouseover（播放器才知道鼠标来了）", st && st.over > 0, JSON.stringify(st));
  ok("红点移动时补发了 mousemove", st && st.move > 0, JSON.stringify(st));
  await key(23, 240);
  const log2 = await evalJs("document.getElementById('log').textContent");
  ok("悬停目标也能被点中", log2 === "HOVER-CLICK", "页面回执='" + log2 + "'");

  // ── 同源 iframe 下钻：红点移到 iframe 上按确定，内层按钮应被点到 ──
  for (let i = 0; i < 3; i++) await key(22, 80);   // 回中间列
  for (let i = 0; i < 3; i++) await key(20, 80);   // 下移 3 格
  // 动态造出同源按钮 iframe（真实回放站的播放器 iframe 就是同源相对地址）
  await evalJs("window.__makeFrame('frame1','/inner-btn'," + geom.cx0 + "," + (geom.cy0 + 3 * geom.sy) + ",300,100)");
  await sleep(900);
  const p5 = await pos();
  ok("红点能移到同源 iframe 上方",
    p5.x === geom.cx0 && p5.y === geom.cy0 + 3 * geom.sy, JSON.stringify(p5));
  await key(23, 300);
  const inFrame = await evalJs("window.__iframeClicked === true");
  ok("同源 iframe 内部的按钮也能被点到（脚本会下钻）", inFrame === true, "iframe 回执=" + inFrame);

  // ── 钻进同源 iframe 找视频：初始落点应落在 iframe 内视频的中心 ──
  const fx = geom.cx0 - 3 * geom.sx, fy = geom.cy0 - 3 * geom.sy;
  await evalJs("window.__makeFrame('frame2','/inner-video'," + fx + "," + fy + ",300,160)");
  await sleep(900);
  await evalJs("window.__tvNav.reset()");
  await sleep(200);
  const p6 = await pos();
  ok("页面里的视频藏在同源 iframe 内时，红点也能钻进去落到视频中心",
    p6.x === fx && p6.y === fy, JSON.stringify(p6) + "（期望 " + fx + "," + fy + "）");

  // ── 重复注入不产生第二个红点 ──
  await evalJs(js);
  await sleep(200);
  const dotCount = await evalJs("document.querySelectorAll('#__tvnav_dot').length");
  ok("重复注入不会产生多个红点", dotCount === 1, "数量=" + dotCount);

  // ══════════════════════════════════════════════════════════
  // [4] 边缘滚动：红点贴到屏幕边缘后，应向移动方向滚动页面
  // ══════════════════════════════════════════════════════════
  console.log("\n[4] 边缘滚动（红点贴边 → 朝该方向滚页面）");

  // 一次 CDP 往返里连按 n 次（按键处理是同步的，比 n 次往返快得多）
  const keys = async (code, n) => {
    await evalJs("(function(){for(var i=0;i<" + n + ";i++){window.__tvNav.key(" + code + ");}})()");
    await sleep(240);
  };

  // 清掉前面为其它用例造的同源 iframe，否则 reset() 会把红点吸到 iframe 里的 video 上
  await evalJs("['frame1','frame2'].forEach(function(i){var e=document.getElementById(i);if(e){e.parentNode.removeChild(e);}})");
  await sleep(150);

  // ── 4a 整页竖向滚动（持续滚，不是只滚一下）──
  await evalJs("window.scrollTo(0,0)");
  await evalJs("window.__tvNav.reset()");
  await keys(20, 30);                    // 一路按「下」：先走到下边缘，再开始滚
  const s1 = await evalJs("window.scrollY");
  await keys(20, 6);
  const s2 = await evalJs("window.scrollY");
  ok("红点顶到下边缘后，继续按「下」会向下滚动页面", s1 > 0, "scrollY=" + s1);
  ok("是「持续滚动」而不是只滚一次：再按 6 次仍在继续下滚", s2 > s1, "scrollY " + s1 + " → " + s2);

  // ── 4b 反向：顶到上边缘后按「上」滚回去 ──
  // v1.4.4 注：红点移动步长调细后，红点从下边缘走到上边缘需要更多次按键，
  // 固定次数会不够用，故这里循环按「上」直到回到顶部（或到安全上限）。
  let s3 = await evalJs("window.scrollY");
  for (let i = 0; i < 150 && s3 > 0; i++) {
    await key(19, 40);
    s3 = await evalJs("window.scrollY");
  }
  ok("顶到上边缘后继续按「上」会把页面滚回顶部（上下双向都通）", s3 === 0, "scrollY " + s2 + " → " + s3);

  // ── 4c 页面不能滚动时，红点仍能贴到硬边界（否则最右/最下 36px 的内容永远点不到）──
  await keys(22, 40);
  const pR = await pos();
  ok("页面不能横向滚动时，红点能贴到距右边 " + HARD + "px 处",
    pR.x === geom.vw - HARD, "x=" + pR.x + "（期望 " + (geom.vw - HARD) + "）");
  await keys(19, 40);
  const pT = await pos();
  ok("红点始终被夹在视口内（不会跑出屏幕）",
    pT.x >= HARD && pT.x <= geom.vw - HARD && pT.y >= HARD && pT.y <= geom.vh - HARD,
    JSON.stringify(pT) + " / 视口 " + geom.vw + "x" + geom.vh);

  // ── 4d 内部可滚容器优先（对应线上播放页右侧那个 .play-box-side-main）──
  await evalJs(`(function(){
    var d=document.createElement('div');
    d.id='scroller';
    d.style.cssText='position:fixed;left:0;top:0;width:100%;height:100%;overflow:auto;background:#1b1b1b;z-index:5000';
    d.innerHTML='<div style="height:4000px;color:#fff">inner list</div>';
    document.body.appendChild(d);
    d.scrollTop=0; window.scrollTo(0,0);
  })()`);
  await sleep(250);
  await evalJs("window.__tvNav.reset()");
  await keys(20, 12);
  const innerTop = await evalJs("document.getElementById('scroller').scrollTop");
  const winY1 = await evalJs("window.scrollY");
  ok("红点落在内部可滚容器上时，先滚这个容器（浏览器滚轮的接力行为）",
    innerTop > 0, "容器 scrollTop=" + innerTop);
  ok("此时整页先不动（不会「想滚列表却把整页滚飞」）", winY1 === 0, "window.scrollY=" + winY1);

  // ── 4e 内部容器滚到头后自动接力滚整页（scroll chaining）──
  const innerMax = await evalJs("(function(){var s=document.getElementById('scroller');return s.scrollHeight-s.clientHeight;})()");
  await evalJs("(function(){var s=document.getElementById('scroller');s.scrollTop=s.scrollHeight;})()");
  await sleep(150);
  await keys(20, 8);
  const innerTop2 = await evalJs("document.getElementById('scroller').scrollTop");
  const winY2 = await evalJs("window.scrollY");
  ok("内部容器滚到底后，接力滚动整页（不会卡死在里面）", winY2 > 0, "window.scrollY=" + winY2);
  ok("接力过程中内部容器停在底部不再乱动", Math.abs(innerTop2 - innerMax) <= 2,
    "容器 scrollTop=" + innerTop2 + " / 最大值 " + innerMax);

  // ── 4f 横向可滚容器 ──
  await evalJs(`(function(){
    var d=document.createElement('div');
    d.id='hscroll';
    d.style.cssText='position:fixed;left:0;top:0;width:100%;height:100%;overflow-x:auto;overflow-y:hidden;background:#111;z-index:6000';
    d.innerHTML='<div style="width:5000px;height:100%;color:#fff">wide row</div>';
    document.body.appendChild(d);
    d.scrollLeft=0; window.scrollTo(0,0);
  })()`);
  await sleep(250);
  await evalJs("window.__tvNav.reset()");
  await keys(22, 30);
  const hLeft = await evalJs("document.getElementById('hscroll').scrollLeft");
  const pH = await pos();
  ok("红点贴到右边缘后按「右」会横向滚动容器（横排剧集/选集也走得动）",
    hLeft > 0, "容器 scrollLeft=" + hLeft);
  ok("横向滚动时红点仍留在视口内", pH.x >= HARD && pH.x <= geom.vw - HARD, JSON.stringify(pH));

  try { sock.close(); } catch (e) {}
  killTree();   // 连树杀掉整棵 Chrome（防 renderer 孤儿进程空转吃 CPU）
  try { server.close(); } catch (e) {}
  await sleep(900);   // 给 Chrome 一点时间释放 profile 目录里的文件句柄
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(userDir, { recursive: true, force: true }); break; }
    catch (e) { await sleep(600); }
  }

  console.log("\n" + "═".repeat(64));
  console.log("结果：通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("  ❌ 验证过程异常：" + e.message);
  try { server.close(); } catch (x) {}
  bail(1);
});
