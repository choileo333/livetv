/**
 * 探针：在真实无头 Chrome 里打开详情页，全程监听网络，
 * 看「站点自己的播放器」请求 m3u8 时带了什么头、服务器回了什么。
 * ─────────────────────────────────────────────────────────────
 * 回答的关键问题：
 *   Q1 站点自己的播放器到底有没有成功拿到 m3u8？（能拿到 → 是源可播，我们取流的头不对）
 *   Q2 它请求 m3u8 时带了哪些头（Referer / Cookie / Origin）？
 *   Q3 拿到的 m3u8 内容长什么样？
 *   Q4 站点自己的 video 最终有没有播出画面（readyState / currentTime）？
 *
 * 用法：node tools/probe_stream_net.js
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = "https://tvlive-relay.app.workbuddy.host";
const LIST_PAGE = "https://www.dodotv20.com/show.php?tid=3&order_type=";
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
  if (!CHROME) { console.log("未找到 Chrome"); process.exit(1); }
  const page = await freshPlayPage();
  if (!page) { console.log("未抓到详情页"); process.exit(1); }
  console.log("详情页：", page);
  console.log("");

  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0",
    "--user-data-dir=C:/WINDOWS/Temp/tvlive-net-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,720",
    "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "--mute-audio",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.log("无头浏览器未就绪"); process.exit(1); }

  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws 失败")); });

  let id = 0; const pend = new Map(); const events = [];
  const fetchHandlers = [];
  sock.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg.result || {}); pend.delete(msg.id); }
    else if (msg.method === "Fetch.requestPaused") {
      // 命中反调试脚本 → 回一个空 JS（与 App 里 shouldInterceptRequest 的做法一致）
      const u = (msg.params.request && msg.params.request.url) || "";
      const block = /disable-devtool|disable_devtool|disabledev|devtools-detector/i.test(u);
      if (block) {
        blocked++;
        cmd("Fetch.fulfillRequest", {
          requestId: msg.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" }],
          body: Buffer.from("").toString("base64"),
        });
      } else {
        // 其余请求一律放行 —— 全量拦截时漏掉这一步会让整个页面卡死（实测全 0 请求）
        cmd("Fetch.continueRequest", { requestId: msg.params.requestId });
      }
    }
    else if (msg.method) events.push(msg);
  };
  let blocked = 0;
  const cmd = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  // 单独 pattern "*" 全量拦截才稳定命中（多 pattern 实测一个都不触发）；命中后在处理器里按 URL 过滤
  await cmd("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cmd("Network.enable", { maxTotalBufferSize: 20000000, maxResourceBufferSize: 5000000 });
  await cmd("Page.enable", {});
  await cmd("Runtime.enable", {});
  await cmd("Network.setCacheDisabled", { cacheDisabled: true });

  // 会话内所有请求（含 iframe 子帧），按 requestId 归集
  const reqs = new Map();
  const onEvent = () => {
    while (events.length) {
      const m = events.shift();
      if (m.method === "Network.requestWillBeSent") {
        reqs.set(m.params.requestId, { url: m.params.request.url, headers: m.params.request.headers, initiator: m.params.initiator && m.params.initiator.type });
      } else if (m.method === "Network.responseReceived") {
        const r = reqs.get(m.params.requestId);
        if (r) { r.status = m.params.response.status; r.mime = m.params.response.mimeType; r.respHeaders = m.params.response.headers; }
      } else if (m.method === "Network.loadingFinished") {
        const r = reqs.get(m.params.requestId);
        if (r) { r.encodedLength = m.params.encodedDataLength; }
      }
    }
  };

  await cmd("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(page) });

  // 轮询等到「详情页里的播放器 iframe」出现（广告门 6 秒 + 加载时间），最多 35 秒
  let framesSeen = 0;
  for (let i = 0; i < 35; i++) {
    await sleep(1000); onEvent();
    const n = await ev(`document.getElementsByTagName('iframe').length`);
    if (n && n > framesSeen) framesSeen = n;
    if (n >= 2) break;                       // adFrame + view_iframe 都出来了
  }
  await sleep(3000); onEvent();              // 再给播放器一点时间发起取流

  console.log("  （被拦掉的反调试脚本请求：" + blocked + " 次 · 见过的最多 iframe 数：" + framesSeen + "）");

  const interesting = [...reqs.values()].filter((r) =>
    /\.m3u8/i.test(r.url) || /onet\.php/i.test(r.url) || /\.ts(\?|$)/i.test(r.url));
  console.log("════════ 网络流水（只列 m3u8 / onet.php / .ts） ════════");
  if (!interesting.length) console.log("  （一条都没有 —— 站点连取流请求都没发出）");
  for (const r of interesting) {
    console.log("  ▸ " + (r.status || "?") + "  " + (r.mime || "?") + "  " + (r.encodedLength != null ? r.encodedLength + "B" : ""));
    console.log("      URL    : " + r.url.slice(0, 120));
    const h = r.headers || {};
    console.log("      Referer: " + (h.Referer || h.referer || "（无）"));
    console.log("      Origin : " + (h.Origin || h.origin || "（无）"));
    const ck = h.Cookie || h.cookie;
    console.log("      Cookie : " + (ck ? String(ck).slice(0, 80) : "（无）"));
    console.log("      UA     : " + String(h["User-Agent"] || h["user-agent"] || "（无）").slice(0, 60));
  }

  console.log("");
  console.log("════════ 站点自己的 video 现在什么状态 ════════");
  const st = await ev(`(function(){
    var out=[];
    function walk(d,dep){ if(!d||dep>3) return; var v=d.getElementsByTagName('video');
      for(var i=0;i<v.length;i++){ var x=v[i]; out.push({dep:dep, rs:x.readyState, ct:+(x.currentTime||0).toFixed(2),
        dw:x.videoWidth, dh:x.videoHeight, paused:x.paused, err:x.error?('code='+x.error.code):null, src:(x.currentSrc||x.src||'').slice(0,80)}); }
      var f=d.getElementsByTagName('iframe');
      for(var j=0;j<f.length;j++){ try{ if(f[j].contentDocument) walk(f[j].contentDocument,dep+1); }catch(e){} } }
    walk(document,0); return JSON.stringify(out);})()`);
  console.log("  " + (st || "[]"));

  console.log("");
  console.log("════════ 站点播放器页(onet.php)的 Hls / Artplayer / vid 情况 ════════");
  const inner = await ev(`(function(){
    try{
      var f=document.getElementsByTagName('iframe'); var res={frames:f.length};
      for(var i=0;i<f.length;i++){ var w=null; try{ w=f[i].contentWindow; }catch(e){}
        try{ if(w && w.Hls) res.hls = 'v'+(w.Hls.version||'?'); }catch(e){}
        try{ if(w && w.Artplayer) res.art = 'yes'; }catch(e){}
        try{ if(w && w.vid) res.vid = String(w.vid); }catch(e){ res.vidErr = String(e && e.message); }
        try{ if(w && w.lastStream) res.lastStream = String(w.lastStream).slice(0,80); }catch(e){}
        try{ var d=f[i].contentDocument; if(d){ res.vc = !!(d.getElementById('video-container')); res.bodyLen = (d.body?d.body.innerHTML.length:0);} }catch(e){}
      }
      return JSON.stringify(res);
    }catch(e){ return 'err:'+e.message; }})()`);
  console.log("  " + inner);

  sock.close(); proc.kill();
})().catch((e) => { console.error(e); process.exit(1); });
