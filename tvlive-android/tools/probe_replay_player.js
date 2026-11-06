/**
 * 回放页「播放器没渲染出来」现场勘察（诊断用，非测试）
 * ─────────────────────────────────────────────────────────────
 * 用户 2026-10-13 反馈：电视上红点能移、能点，但点进具体视频后整块黑屏，
 * 诊断行写着「页面里找不到 video 元素（播放器未渲染出来）」，
 * 而且红点下面浮出的提示是 `(function(){var REF =…` —— 像是**一段脚本源码被当文字显示**。
 *
 * 本探针要回答三个问题：
 *   ① 点进详情页后，DOM 里到底有几个 iframe / video，分别在哪个文档；
 *   ② 红点（屏幕正中）位置 elementFromPoint 命中的是什么元素，它的祖先链长什么样；
 *   ③ 后端注入的 PLAYER_PATCH 脚本落在哪里、是不是真的被渲染成了可见文字。
 *
 * 用法：node tools/probe_replay_player.js
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = "https://tvlive-relay.app.workbuddy.host";
const LIST_PAGE = "https://www.dodotv20.com/show.php?tid=3&order_type=";
const OUT_DIR = path.resolve(__dirname, "probe_out");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把一段 HTML 抓成文件，便于直接肉眼读（不必再跑一次）
async function grab(url, name) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 TvLiveProbe/1.0" } });
    const t = await r.text();
    fs.writeFileSync(path.join(OUT_DIR, name), t, "utf8");
    console.log("  · 抓取 " + name + "  " + r.status + "  " + t.length + " 字节");
    return t;
  } catch (e) {
    console.log("  ! 抓取失败 " + name + "：" + e.message);
    return null;
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) { console.log("未找到 Chrome/Edge"); process.exit(1); }

  const userDir = "C:/WINDOWS/Temp/tvlive-probe-" + Date.now();
  const proc = spawn(chrome, [
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + userDir,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1280,720", "--ignore-certificate-errors",
    "--autoplay-policy=no-user-gesture-required", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let wsUrl = null;
  proc.stderr.on("data", (b) => {
    const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) wsUrl = m[1];
  });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.log("无头浏览器未就绪"); try { proc.kill(); } catch (e) {} process.exit(1); }

  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws 失败")); });

  let id = 0; const pend = new Map(); const navmsgs = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    // 页面 console（含我们脚本的 __TVNAV__ 上报）
    if (m.method === "Runtime.consoleAPICalled") {
      const txt = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      if (txt) navmsgs.push("[" + m.params.type + "] " + txt);
    }
    // 未捕获异常 —— 这正是「播放器脚本初始化失败」的直接证据，之前抓不到
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      navmsgs.push("[EXC] " + (d.exception && (d.exception.description || d.exception.value) || d.text));
    }
    if (m.method === "Log.entryAdded") {
      const en = m.params.entry;
      if (en.level === "error" || en.level === "warning") navmsgs.push("[NET-" + en.level + "] " + en.text + " " + (en.url || ""));
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: (r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

  // ── 1) 列表页：找出「具体视频」的详情链接 ────────────────────
  console.log("═".repeat(70));
  console.log("① 打开回放站列表页（经后端内嵌代理，和 App 里走的完全同一条路）");
  console.log("═".repeat(70));
  await send("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(LIST_PAGE) });
  await sleep(6000);
  const listInfo = await ev(`(function(){
    var as = document.querySelectorAll('a[href*="/api/embed"]');
    var out = [];
    for (var i=0;i<as.length && out.length<400;i++){
      var h = as[i].getAttribute('href')||'';
      var m = h.match(/url=([^&]+)/);
      out.push({ text:(as[i].textContent||'').replace(/\\s+/g,' ').trim().slice(0,40), url: m?decodeURIComponent(m[1]):'' });
    }
    return { title:document.title, count: as.length, sample: out };
  })()`);
  console.log("  页面标题：" + (listInfo && listInfo.title));
  console.log("  站内链接数：" + (listInfo && listInfo.count));

  // 挑出「具体视频」：dodotv 的详情/播放页形态是 show.php?...detail 或 shplay.php
  const links = (listInfo && listInfo.sample) || [];
  const playish = links.filter((l) => /\/(shplay|play|vod|view|detail)\.php/i.test(l.url) || /id=/.test(l.url));
  console.log("  疑似详情/播放链接 " + playish.length + " 条，前 8 条：");
  playish.slice(0, 8).forEach((l, i) => console.log("    [" + i + "] " + l.text + "  ->  " + l.url));

  await grab(BASE + "/api/embed?url=" + encodeURIComponent(LIST_PAGE), "list_page.html");

  // ── 2) 详情页：现场结构勘察 ────────────────────────────────
  const target = (playish[0] || links[0] || {}).url;
  if (!target) { console.log("❌ 列表页里没抓到可点的详情链接，无法继续"); try { sock.close(); } catch (e) {} try { proc.kill(); } catch (e) {} process.exit(1); }

  console.log("");
  console.log("═".repeat(70));
  console.log("② 点进具体视频：" + target);
  console.log("═".repeat(70));
  await send("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(target) });
  await sleep(9000);

  const dump = await ev(`(function(){
    function descEl(el, max) {
      if (!el) return null;
      var o = {
        tag: (el.tagName||'').toLowerCase(),
        id: el.id || '',
        cls: (typeof el.className === 'string' ? el.className : '').slice(0,80),
        kids: el.children ? el.children.length : -1,
        rect: (function(){ var r = el.getBoundingClientRect(); return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]; })(),
        text: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 120),
        src: el.getAttribute ? (el.getAttribute('src')||'') : ''
      };
      // 祖先链：用来判断「这个元素为什么会露在屏幕上」
      var chain = [], n = el.parentElement, d = 0;
      while (n && d < 8) { chain.push((n.tagName||'').toLowerCase() + (n.id?('#'+n.id):'') + (n.className&&typeof n.className==='string'?('.'+n.className.split(/\\s+/)[0]):'')); n = n.parentElement; d++; }
      o.chain = chain.join(' < ');
      return o;
    }
    var out = { url: location.href, title: document.title, vw: innerWidth, vh: innerHeight };
    // 视口正中（红点初始落点）命中的元素
    out.centerHit = descEl(document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2)));
    // 所有 iframe
    out.iframes = [];
    var fs = document.getElementsByTagName('iframe');
    for (var i=0;i<fs.length;i++){
      var r = fs[i].getBoundingClientRect();
      var rec = { src: fs[i].getAttribute('src'), w: Math.round(r.width), h: Math.round(r.height), sameOrigin: null, videos: -1, innerCenter: null };
      try {
        var d2 = fs[i].contentDocument;
        rec.sameOrigin = !!d2;
        if (d2) {
          rec.videos = d2.getElementsByTagName('video').length;
          rec.innerCenter = descEl(d2.elementFromPoint(Math.round(r.width/2), Math.round(r.height/2)));
          rec.bodyHead = d2.body ? d2.body.innerHTML.slice(0, 300) : '(无 body)';
        }
      } catch(e) { rec.sameOrigin = 'BLOCKED'; }
      out.iframes.push(rec);
    }
    // 顶层所有 video
    out.topVideos = [];
    var vs = document.getElementsByTagName('video');
    for (var j=0;j<vs.length;j++) out.topVideos.push(descEl(vs[j]));
    // 被「渲染成可见文字」的 script（病征：offsetParent 不为 null）
    out.visibleScripts = [];
    var ss = document.getElementsByTagName('script');
    for (var k=0;k<ss.length;k++){
      if (ss[k].offsetParent !== null || (ss[k].getBoundingClientRect().height > 2)) {
        out.visibleScripts.push({ idx:k, src: ss[k].getAttribute('src')||'(内联)', head:(ss[k].textContent||'').replace(/\\s+/g,' ').trim().slice(0,140), parent:(ss[k].parentElement||{}).tagName, rect: (function(){var r=ss[k].getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)];})() });
      }
    }
    // 页面里是否存在注入补丁的标志
    out.hasPatchGlobal = (function(){ try { return !!document.querySelector('script'); } catch(e){ return false; } })();
    return out;
  })()`);

  console.log(JSON.stringify(dump, null, 2));

  // ── 3) 抓原始 HTML（未经代理 vs 经代理，对比注入点） ────────
  console.log("");
  console.log("═".repeat(70));
  console.log("③ 原始 HTML 对比：直连上游 vs 经代理改写");
  console.log("═".repeat(70));
  await grab(target, "play_page_direct.html");
  await grab(BASE + "/api/embed?url=" + encodeURIComponent(target), "play_page_embed.html");

  // 找注入了补丁的那一页：详情页里的播放器 iframe（xiaoca.top）
  const ifr = (dump && dump.iframes || []).map((f) => f.src).filter(Boolean);
  for (let i = 0; i < ifr.length && i < 3; i++) {
    const u = ifr[i];
    console.log("  iframe[" + i + "] = " + u);
    if (/\/api\/embed\?url=/.test(u)) {
      const q = decodeURIComponent((u.match(/url=([^&]+)/) || [])[1] || "");
      await grab(u.startsWith("http") ? u : (BASE + u), "player_iframe_page.html");
      if (q) await grab(BASE + "/api/embed?url=" + encodeURIComponent(q), "player_iframe_embed.html");
    }
  }

  console.log("");
  console.log("═".repeat(70));
  console.log("④ 页面 console / 异常 / 网络错误（原样保留，含 __TVNAV__ 上报）");
  console.log("═".repeat(70));
  navmsgs.slice(0, 80).forEach((m) => console.log("  " + m.slice(0, 300)));
  if (!navmsgs.length) console.log("  （无）");

  console.log("");
  console.log("抓取的文件都在：" + OUT_DIR);
  try { sock.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
})().catch((e) => { console.log("探针异常：" + e.stack); process.exit(1); });
