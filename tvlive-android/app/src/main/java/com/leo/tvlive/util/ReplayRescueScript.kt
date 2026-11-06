package com.leo.tvlive.util

/**
 * 回放页「播放器兜底」注入脚本（v1.4.0）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 用户 2026-10-13 反馈：电视上点进具体视频后整块黑屏，连播放器都不出现；同一个页面在手机上正常。
 * 线上实测（tools/probe_play_page.js / probe_gate.js / probe_player_deps2.js / probe_timeline.js）得到的结论：
 *
 *   1) 站点结构是「列表页 → 详情页 → 播放器 iframe」：
 *        详情页里 <iframe id="view_iframe" class="video-frame" src="/api/embed?url=<播放器页 onet.php)>">
 *        播放器页里 <div id="video-container"> 由 Artplayer + hls.js 填充。
 *   1b) 【v3 关键修正】iframe src 里那串 `...onet.php?url=https://wiselife.blog/pop/xxx.m3u8`
 *      **不是可播地址**：实测它恒返回 404，是已废弃的「频道入口」。
 *      真正能播的是播放器页全局变量 `vid`（common.js 用 base64+XOR 解出），形如
 *        https://wiselife.blog/hls/<id>.m3u8?t=..&n=..&s=.. （带服务端签名，每次请求都变）。
 *      ⇒ 取流**首选**读 iframe 的 `contentWindow.vid`（iframe 经本后端 /api/embed 代理，与顶层同源，可直读）。
 *      ⇒ 但真机（尤其老电视盒子）实测 common.js 会因各种原因未执行，导致 `vid` 未定义，
 *        所以兜底脚本必须自己能复刻 common.js 的解密：从 onet.php HTML 里取 `phpsiteEc2`/`phpsitekey3`，
 *        做 base64_decode → XOR → base64_decode，自己算出 vid。
 *      ⇒ 老写法（从 iframe src 里解析 m3u8）会把 404 的入口地址喂给 hls.js → manifestParsingError，白等一场。
 *   2) 详情页还有一段「广告倒计时」：先显示 #adFrame（广告，z-index 10 盖住播放器），
 *      6 秒后藏掉广告、把 .video-frame 显示出来。这段脚本在电视上不一定跑得起来。
 *   3) 播放器页里只要有一处脚本跑不动（内核太旧、依赖没加载、被反调试脚本误伤），
 *      #video-container 就永远是空的 —— 于是整个 body 高度为 0，红点在那一带命中的是 <html>，
 *      浮出的提示成了我们注入补丁的脚本源码（用户截图里那行 `(function(){var REF =…` 就是这么来的）。
 *   4) **站点还挂了「反调试」脚本**（详情页脚本标签带 disable-devtool-auto、播放器页有 /mediaframe/disabledev2.js
 *      与 toDevtools()）。无头浏览器实测：脚本一旦「自以为」被开发者工具盯着，
 *      轻则整页跳 error0.html，重则直接把页面清成 about:blank，
 *      控制台留下 `You don't have permission to use DEVTOOL!【type = 6】`。
 *      在电视盒子/WebView 上它很容易误判 —— 这正是「整块黑屏」最可能的直接原因。
 *      ⇒ App 侧已在 shouldInterceptRequest 里把这类脚本拦掉了（见 MainActivity.ANTI_DEBUG_RE）。
 *
 * 也就是说：「黑屏」不是解码问题，而是「播放器压根没被建出来 / 页面被清空了」。
 * 光等是等不来的，必须在等不到的时候自己把播放器建起来。
 *
 * ── 本脚本做什么 ─────────────────────────────────────────────
 * 在回放页（顶层文档，可下钻同源 iframe）里每 2 秒巡检一次，共 45 秒：
 *   ① 页面里已经有「能播的 video」→ 什么都不做（绝不打扰站点自己的播放器）；
 *   ② 每轮都把「见过的最新 m3u8」记下来 —— 哪怕播放器 iframe 之后被清空/跳走，我们手里仍有流地址；
 *   ③ 超过 12 秒广告遮罩还没放开 → 兜底把广告藏掉、把真播放器显出来（附 !important 样式）；
 *   ④ 超过 9 秒还没有能播的 video → 自己建一个：
 *        · 优先建在站点播放器 iframe 里（保持原有版式）；
 *        · 播放器页取不到（被反调试清空 / 跨域）就建在**顶层页面**、盖在播放器位置上；
 *        · 取流走本后端中继（中继在服务端补上播放器要求的 Referer，绕过防盗链）；
 *        · 顺手把该文档的 XHR/fetch 也接到中继上（hls.js 后续的分片请求同样要带对 Referer）；
 *        · 优先复用播放器页里已加载好的 hls.js（0.14.17，ES5，老内核跑得动）；
 *          没有就从本后端同源加载 /hls.min.js（1.7.3，压缩版同样是 ES5）；
 *        · 本机没有 MSE 时退化成系统原生 HLS（`video.canPlayType('application/vnd.apple.mpegurl')`）。
 *
 * ── 与 Kotlin 侧的约定 ────────────────────────────────────────
 * 上报走 console.log，前缀 __TVNAV__（与 TvNavScript 一致）：
 *   `__TVNAV__ rescue <内容>` → 自建播放的进展/失败原因
 *   `__TVNAV__ gate <内容>`   → 广告遮罩兜底放开的说明
 * 调试入口：window.__tvRescue.tick() 立即巡检一次；window.__tvRescue.state() 看当前状态。
 *
 * ── 刻意不做的三件事 ─────────────────────────────────────────
 * 1) 不永久替代站点播放器：只在「它没建出来」时才动手，且用绝对定位盖在容器上层，不删它的 DOM。
 * 2) 不做无意义的反复重试：45 秒后停手。反复重试只会把电视 CPU 拖死，对用户毫无帮助。
 * 3) 不把解密逻辑做进 App/Kotlin：解密规则可能随站点更新而变，放在注入脚本里便于热更新。
 */
object ReplayRescueScript {

    /**
     * 脚本版本：重复注入时用于短路。改动脚本逻辑必须递增，否则已在页面里跑的旧版本不会更新。
     */
    private const val VERSION = 4

    /** 待注入的脚本源码（严格 ES5：不用箭头函数 / let / const / 模板字符串，兼容老电视盒子） */
    val JS: String = """
(function () {
  var V = $VERSION;
  if (window.__tvRescue && window.__tvRescue.version === V) { return; }

  var MAX_DEPTH = 3;      // 同源 iframe 下钻层数上限（防嵌套循环）
  var GRACE_MS = 9000;    // 给站点自己的播放器这么久的耐心，之后才接管
  var GATE_MS = 12000;    // 广告遮罩超过这么久还不放开，就兜底放开
  var STOP_MS = 45000;    // 巡检总时长：到点收手，不做无限重试
  var bornAt = Date.now();
  var gateFixed = false;  // 是否已兜底放开过广告/播放器
  var tried = false;      // 是否已尝试自建播放器
  var lastStream = null;  // 见过的最新流地址（if rame 被清空后仍能救回来）
  var timer = null;

  /** 统一的 console 上报通道（Kotlin 侧凭 __TVNAV__ 前缀识别） */
  function report(kind, msg) {
    try { console.log('__TVNAV__ ' + kind + ' ' + msg); } catch (e) {}
  }

  /** 元素是否可见（有尺寸 + 没被隐藏）。用 ownerDocument.defaultView 取样式，iframe 内部也准 */
  function vis(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var s = null;
    try { s = w.getComputedStyle(el); } catch (e) { s = null; }
    if (s && (s.display === 'none' || s.visibility === 'hidden')) return false;
    return true;
  }

  /**
   * 递归找「已经在播/已经出画面」的 video；没有就返回 null。
   * 判据刻意放宽到「readyState>=2（有当前帧数据）或不在暂停」——
   * 只要站点自己的播放器活了，我们就绝不出手。
   */
  function aliveVideo(doc, depth) {
    if (!doc || depth > MAX_DEPTH) return null;
    var vs = doc.getElementsByTagName('video');
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      if (!vis(v)) continue;
      if (v.error) continue;
      if (v.readyState >= 2 || !v.paused) return v;
    }
    var fs = doc.getElementsByTagName('iframe');
    for (var j = 0; j < fs.length; j++) {
      var idoc = null;
      try { idoc = fs[j].contentDocument; } catch (e) { idoc = null; }   // 跨域拿不到，跳过
      if (!idoc) continue;
      var r = aliveVideo(idoc, depth + 1);
      if (r) return r;
    }
    return null;
  }

  /** 统计页面（含同源 iframe）里 video 的总数 / 隐藏数 / 可见数 —— 用于把「真没有」和「有但藏着」分开说 */
  function videoStats(doc, depth, acc) {
    if (!doc || depth > MAX_DEPTH) return acc;
    var vs = doc.getElementsByTagName('video');
    for (var i = 0; i < vs.length; i++) {
      acc.total++;
      if (vis(vs[i])) acc.visible++; else acc.hidden++;
    }
    var fs = doc.getElementsByTagName('iframe');
    for (var j = 0; j < fs.length; j++) {
      var idoc = null;
      try { idoc = fs[j].contentDocument; } catch (e) { idoc = null; }
      if (idoc) videoStats(idoc, depth + 1, acc);
    }
    return acc;
  }

  /**
   * 「这串本身是不是一个 m3u8 地址」——必须看 pathname 真的以 .m3u8 结尾。
   * 不能用 indexOf('.m3u8')：`.../onet.php?url=xxx.m3u8` 这种「m3u8 只是查询参数」会被误判成可播地址，
   * 喂给 hls.js 只会得到 manifestParsingError（v2 就是这么栽的）。
   */
  function isM3u8(u) {
    var s = String(u || '');
    var cut = s.indexOf('#');
    if (cut >= 0) s = s.slice(0, cut);
    cut = s.indexOf('?');
    if (cut >= 0) s = s.slice(0, cut);
    return /\.m3u8$/i.test(s);
  }

  /**
   * 从播放器页地址里解出「播放器页自己的 origin」，作为取流时的 Referer。
   * 站点形如：/api/embed?url=https%3A%2F%2Fxiaoca.top%2Fone%2Fonet.php%3Furl%3D…m3u8&ref=…
   * 实测流服务器只认播放器域的 Referer（送 https://xiaoca.top/ 才 200），这是我们后端中继要补的那个头。
   */
  function refOf(purl) {
    if (!purl) return '';
    var raw = String(purl);
    var inner = '';
    try {
      var u = new URL(raw, location.href);
      if (u.searchParams && u.searchParams.get('url')) inner = u.searchParams.get('url');
    } catch (e) { inner = ''; }
    if (!inner) {
      var m = raw.match(/[?&]url=([^&]+)/);            // 老内核若缺 URLSearchParams 的退路
      if (m) { try { inner = decodeURIComponent(m[1]); } catch (e) { inner = ''; } }
    }
    try { return new URL(inner || raw, location.href).origin + '/'; } catch (e) { return ''; }
  }

  /**
   * 纯 ES5 的 base64 解码（与 common.js 里那段等价）。
   * 站点/common.js 用的是 PHP 风格 base64_decode；这里自己实现，避免老内核缺 atob 或 btoa 的坑。
   */
  function base64Decode(data) {
    var b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var o1, o2, o3, h1, h2, h3, h4, bits, i = 0, ac = 0, dec = '', tmpArr = [];
    if (!data) return data;
    data += '';
    // 补齐 padding（有些实现会省略末尾的 =）
    while (data.length % 4 !== 0) data += '=';
    do {
      h1 = b64.indexOf(data.charAt(i++));
      h2 = b64.indexOf(data.charAt(i++));
      h3 = b64.indexOf(data.charAt(i++));
      h4 = b64.indexOf(data.charAt(i++));
      bits = h1 << 18 | h2 << 12 | h3 << 6 | h4;
      o1 = bits >> 16 & 0xff;
      o2 = bits >> 8 & 0xff;
      o3 = bits & 0xff;
      if (h3 === 64) tmpArr[ac++] = String.fromCharCode(o1);
      else if (h4 === 64) tmpArr[ac++] = String.fromCharCode(o1, o2);
      else tmpArr[ac++] = String.fromCharCode(o1, o2, o3);
    } while (i < data.length);
    dec = tmpArr.join('');
    return dec;
  }

  /** 把 s 用 key 做循环 XOR（与 common.js 里 vid 的解密步骤一致） */
  function xorKey(s, key) {
    if (!s || !key) return '';
    var out = '';
    for (var i = 0; i < s.length; i++) {
      out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }

  /** 从一段 HTML/JS 文本里提取 `var <name> = "value";` 的字符串值（name 为固定已知，无需转义） */
  function extractVar(html, name) {
    if (!html) return '';
    var re = new RegExp('var\\s+' + name + '\\s*=\\s*"([^"]+)"');
    var m = String(html).match(re);
    return (m && m[1]) ? m[1] : '';
  }

  /**
   * 自己复刻 common.js 的解密，从 onet.php HTML 里算出真实流地址 vid。
   *
   * 站点 common.js 逻辑（已反推验证）：
   *   vid = base64_decode( xor( base64_decode(phpsiteEc2), phpsitekey3 ) )
   * 这一步必须自己做，因为真机上 common.js 常因反调试/缓存/网络失败而没有执行，
   * 但 phpsiteEc2/phpsitekey3 是内联在 onet.php HTML 里的，一定能读到。
   */
  function decodeVidFromHtml(html) {
    var ec2 = extractVar(html, 'phpsiteEc2');
    var key = extractVar(html, 'phpsitekey3');
    if (!ec2 || !key) return '';
    try {
      var step1 = base64Decode(ec2);
      var step2 = xorKey(step1, key);
      var step3 = base64Decode(step2);
      if (isM3u8(step3)) return step3;
    } catch (e) {}
    return '';
  }

  /**
   * 取真实流地址：读播放器页(onet.php)的全局变量 vid。
   *
   * vid 由 common.js 同步解出（base64 + XOR），形如 https://wiselife.blog/hls/<id>.m3u8?t=…&n=…&s=…
   * —— 带着服务端签名，是唯一真正能播的地址。**不允许**退回 iframe src 里的 `pop/xxx.m3u8`：那是失效入口。
   * 读得到的前提是 iframe 与顶层同源 —— 站点经本后端 /api/embed 代理后正好满足。
   *
   * 真机 fallback：如果 common.js 没执行（vid 未定义），就自己读 iframe HTML 解密出 vid。
   */
  function readVid(frame) {
    if (!frame) return null;
    var v = '';
    try { v = (frame.win && frame.win.vid) ? String(frame.win.vid) : ''; } catch (e) { v = ''; }
    if (!v) { try { v = (frame.doc && frame.doc.vid) ? String(frame.doc.vid) : ''; } catch (e) { v = ''; } }
    if (!v && frame.doc && frame.doc.documentElement) {
      try {
        var html = frame.doc.documentElement.outerHTML || '';
        v = decodeVidFromHtml(html);
      } catch (e) { v = ''; }
    }
    if (!isM3u8(v)) return null;
    return { stream: v, ref: refOf(frame.url) };
  }

  /**
   * 把当前页面（含同源 iframe，逐层下钻）里播放器页的 vid 读一遍，记住最新的真实流地址。
   * 必须每轮都扫：播放器 iframe 可能在广告结束后才出现，也可能随后被反调试脚本清空 ——
   * 只要它「曾经出现过」，我们手里就留住了那个带签名的流地址，后面才救得回来。
   */
  function walkVid(doc, depth) {
    if (!doc || depth > MAX_DEPTH) return;
    var fs = doc.getElementsByTagName('iframe');
    for (var i = 0; i < fs.length; i++) {
      var idoc = null;
      try { idoc = fs[i].contentDocument; } catch (e) { idoc = null; }
      if (!idoc) continue;                              // 跨域拿不到 → 读不了 vid，跳过
      var url = '';
      try { url = fs[i].getAttribute('src') || ''; } catch (e) { url = ''; }
      var info = readVid({ doc: idoc, win: idoc.defaultView || window, url: url });
      if (info) lastStream = info;                      // 后读到的覆盖先读到的（vid 带时效签名，越新越好）
      walkVid(idoc, depth + 1);
    }
  }

  function scanStreams() {
    walkVid(document, 0);
    return lastStream;
  }

  /**
   * 找承载播放器的那个同源 iframe。
   * 站点形态：<iframe id="view_iframe" src="/api/embed?url=<播放器页>">，播放器页里有 #video-container。
   */
  function findFrame(doc, depth) {
    if (!doc || depth > MAX_DEPTH) return null;
    var fs = doc.getElementsByTagName('iframe');
    for (var i = 0; i < fs.length; i++) {
      var idoc = null;
      try { idoc = fs[i].contentDocument; } catch (e) { idoc = null; }
      if (!idoc) continue;
      var url = '';
      try { url = fs[i].getAttribute('src') || ''; } catch (e) { url = ''; }
      var box = null;
      try { box = idoc.getElementById('video-container') || idoc.querySelector('.video-wrapper') || idoc.querySelector('.play-box-main'); } catch (e) { box = null; }
      if (box) return { doc: idoc, win: idoc.defaultView || window, box: box, url: url };
      var deeper = findFrame(idoc, depth + 1);        // 播放器可能还嵌了一层
      if (deeper) return deeper;
      if (idoc.getElementsByTagName('video').length > 0) {
        return { doc: idoc, win: idoc.defaultView || window, box: idoc.body, url: url };
      }
    }
    return null;
  }

  /** 顶层页面里「播放器应该待的位置」：站点自己的播放区容器，找不到就用整页 */
  function findTopBox() {
    var b = null;
    try { b = document.querySelector('.play-box-main'); } catch (e) { b = null; }
    if (!b) {
      try { var vi = document.getElementById('view_iframe'); if (vi) b = vi.parentNode; } catch (e) { b = null; }
    }
    if (!b) b = document.body;
    return b;
  }

  /** 兜底放开广告遮罩：把 #adFrame 藏掉、把真播放器 #view_iframe 显出来 */
  function fixGate() {
    try {
      var css = document.createElement('style');
      css.textContent =
        '.ad-frame{display:none !important;}' +
        '#adFrame{display:none !important;}' +
        '.video-frame{display:block !important;}' +
        'iframe#view_iframe{width:100% !important;height:100% !important;background:#000;}';
      (document.head || document.documentElement).appendChild(css);
    } catch (e) {}
    try {
      var ad = document.getElementById('adFrame');
      if (ad) ad.style.display = 'none';
    } catch (e) {}
    var vi = null;
    try { vi = document.getElementById('view_iframe'); } catch (e) {}
    if (!vi) {   // 没有这个 id（换站了）就挑第一个走本代理的 iframe
      var fs = document.getElementsByTagName('iframe');
      for (var i = 0; i < fs.length; i++) {
        var s = '';
        try { s = fs[i].getAttribute('src') || ''; } catch (e) { s = ''; }
        if (s.indexOf('/api/embed?') >= 0) { vi = fs[i]; break; }
      }
    }
    if (vi) { try { vi.style.display = 'block'; } catch (e) {} }
    report('gate', '广告遮罩超过 ' + Math.round(GATE_MS / 1000) + ' 秒仍未放开，已兜底放开播放器');
  }

  /**
   * 把某个文档的 XHR / fetch 接到本后端中继上。
   *
   * 为什么需要：hls.js 拿到播放列表后还要自己去取分片，而分片在别的域名上（防盗链只认播放器域的 Referer）。
   * 浏览器不可能替我们伪造跨域 Referer，只能让请求先回到我们自己的中继（中继在服务端补 Referer）。
   * 播放器页里站点自己已经装了同样的一段（PLAYER_PATCH）；这里是为「改在顶层页面自建播放」补上的那一份。
   */
  function patchNet(doc, refOrigin) {
    var w = doc.defaultView || window;
    if (w.__tvrescue_patched) return;                  // 幂等：只装一次
    try { w.__tvrescue_patched = 1; } catch (e) { return; }
    var self = '';
    try { self = doc.location.origin; } catch (e) { self = ''; }
    function fix(u) {
      try {
        var abs = new URL(u, doc.location.href);
        if (self && abs.origin === self) return u;     // 已经是我们自己（同源）→ 不动
        return '/api/relay?url=' + encodeURIComponent(abs.toString()) +
               '&ref=' + encodeURIComponent(refOrigin) + '&raw=1';
      } catch (e) { return u; }
    }
    try {
      var X = w.XMLHttpRequest;
      if (X && X.prototype && X.prototype.open) {
        var _open = X.prototype.open;
        X.prototype.open = function () {
          try { arguments[1] = fix(arguments[1]); } catch (e) {}
          return _open.apply(this, arguments);
        };
      }
    } catch (e) {}
    try {
      if (w.fetch) {
        var _f = w.fetch;
        w.fetch = function (i, o) {
          try { if (typeof i === 'string') i = fix(i); } catch (e) {}
          return _f.call(this, i, o);
        };
      }
    } catch (e) {}
  }

  /**
   * 自己建一个播放器接管播放。
   *
   * 为什么用绝对定位强撑尺寸：站点 CSS 靠父级高度撑满，播放器建不出来时 #video-container 高度为 0，
   * 就算我们把 video 塞进去也看不见。这里铺满容器并用 z-index 11（压过广告的 10）。
   */
  function build(frame, info) {
    var d = frame.doc, w = frame.win, box = frame.box;
    if (!box) { report('rescue', '没有可用的容器，放弃自建播放'); return; }
    var H = 0;
    try { H = d.documentElement.clientHeight || (d.body ? d.body.clientHeight : 0) || 0; } catch (e) { H = 0; }
    if (H < 100) H = Math.round((window.innerHeight || 540) * 0.85);

    try {
      d.documentElement.style.height = '100%';
      if (d.body) { d.body.style.height = '100%'; d.body.style.margin = '0'; d.body.style.background = '#000'; }
      box.style.position = 'relative';
      box.style.width = '100%';
      box.style.height = H + 'px';
      box.style.background = '#000';
    } catch (e) {}

    var old = null;
    try { old = d.getElementById('__tvrescue_video'); } catch (e) {}
    if (old && old.parentNode) old.parentNode.removeChild(old);   // 幂等：重复调用不会叠加出多个播放器

    var v = d.createElement('video');
    v.id = '__tvrescue_video';
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.controls = true;
    v.autoplay = true;
    v.style.cssText = 'display:block;position:absolute;left:0;top:0;width:100%;height:100%;' +
                      'background:#000;z-index:11;';
    try { box.appendChild(v); } catch (e) { report('rescue', '播放器元素无法插入容器'); return; }

    patchNet(d, info.ref || '');

    var rel = '/api/relay?url=' + encodeURIComponent(info.stream) +
              '&ref=' + encodeURIComponent(info.ref || '') + '&raw=1';

    /** 本机没有 MSE 时的退路：交给系统原生 HLS（部分老内核反而支持这个） */
    function nativeOrTell(reason) {
      var canNative = false;
      try { canNative = !!v.canPlayType('application/vnd.apple.mpegurl'); } catch (e) { canNative = false; }
      if (canNative) {
        try { v.src = rel; v.play(); } catch (e) {}
        report('rescue', '已改用系统原生 HLS 播放（' + reason + '）');
      } else {
        report('rescue', '本机既跑不了 hls.js 也没有原生 HLS，无法自建播放（' + reason + '）');
      }
    }

    var Hs = w.Hls;   // 播放器页自己加载过的 hls.js（0.14.17，ES5），优先复用

    function withHls() {
      var supported = false;
      try { supported = !!(Hs && Hs.isSupported && Hs.isSupported()); } catch (e) { supported = false; }
      if (!supported) { nativeOrTell('本机不支持 MSE'); return; }
      try {
        var hls = new Hs({
          enableWorker: false,          // 老 WebView 的 Worker 不稳，关掉更保险
          lowLatencyMode: false,
          manifestLoadingTimeOut: 20000,
          fragLoadingTimeOut: 30000,
          manifestLoadingMaxRetry: 2,
          fragLoadingMaxRetry: 2
        });
        hls.on(Hs.Events.MANIFEST_PARSED, function () {
          try { v.play(); } catch (e) {}
          report('rescue', '已自建播放器接管播放（站点播放器未渲染出来）');
        });
        hls.on(Hs.Events.ERROR, function (evt, data) {
          if (data && data.fatal) {
            report('rescue', 'hls 致命错误 ' + (data.type || '') + '/' + (data.details || ''));
          }
        });
        hls.loadSource(rel);
        hls.attachMedia(v);
      } catch (e) {
        nativeOrTell('hls 初始化异常 ' + (e && e.message ? e.message : e));
      }
    }

    if (Hs) { withHls(); return; }
    // 该文档里没有 hls.js（依赖没加载成功）→ 从我们自己的后端同源取一份
    try {
      var s = d.createElement('script');
      s.src = '/hls.min.js';
      s.onload = function () { Hs = w.Hls; if (Hs) { withHls(); } else { nativeOrTell('加载的 hls.js 没有生效'); } };
      s.onerror = function () { nativeOrTell('hls.js 加载失败'); };
      (d.head || d.body || d.documentElement).appendChild(s);
    } catch (e) {
      report('rescue', 'hls.js 注入失败：' + (e && e.message ? e.message : e));
    }
  }

  /** 每 2 秒巡检一次：站点自己活了就什么都不做；一直没活才逐步接管 */
  function tick() {
    var t = Date.now() - bornAt;
    if (t > STOP_MS) { if (timer) { clearInterval(timer); timer = null; } return; }
    scanStreams();                                       // 每轮都把流地址记下来（越早拿到越好）
    if (aliveVideo(document, 0)) return;                 // 站点自己建出来了 → 收手，不干扰
    if (!gateFixed && t > GATE_MS) { gateFixed = true; fixGate(); }
    if (tried || t < GRACE_MS) return;
    tried = true;

    var frame = findFrame(document, 0);
    var info = readVid(frame);       // 首选：直接从播放器容器所在的同源 iframe 读 vid（最准，带签名）
    if (!info) info = lastStream;    // 次选：前面巡检时已经记下来的
    if (!info) {
      var st = videoStats(document, 0, { total: 0, hidden: 0, visible: 0 });
      report('rescue', st.total > 0
        ? ('找到 ' + st.total + ' 个 video 但都没在播（其中 ' + st.hidden + ' 个被隐藏），且拿不到真实流地址')
        : '页面里没有能播的 video，也拿不到真实流地址（播放器页没加载出来或跨域），无法自建播放');
      return;
    }
    if (frame && frame.box) {
      report('rescue', '站点播放器未渲染，开始在播放器容器里自建：' + info.stream.slice(0, 70));
      build(frame, info);
    } else {
      // 连播放器容器都找不到（被反调试清空 / 跳走）→ 就在顶层页面自己盖一个，别让用户白等
      report('rescue', '拿不到站点播放器容器，改在页面顶层自建播放：' + info.stream.slice(0, 70));
      build({ doc: document, win: window, box: findTopBox(), url: '' }, info);
    }
  }

  window.__tvRescue = {
    version: V,
    tick: tick,
    stream: function () { return lastStream; },   // 调试用：直接取出当前记下的真实流地址
    // 调试用：一眼看出当前处于哪一步
    state: function () {
      var st = videoStats(document, 0, { total: 0, hidden: 0, visible: 0 });
      return 'gate=' + gateFixed + ' tried=' + tried +
             ' alive=' + (aliveVideo(document, 0) ? 'yes' : 'no') +
             ' videos=' + st.total + '(' + st.hidden + ' 隐藏)' +
             ' stream=' + (lastStream ? ('yes(' + lastStream.stream.slice(0, 50) + ')') : 'no');
    }
  };

  timer = setInterval(tick, 2000);   // 启动巡检（45 秒后自动收手）
})();
""".trimIndent()
}
