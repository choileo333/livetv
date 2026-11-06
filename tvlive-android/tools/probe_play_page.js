/**
 * 回放站「播放页」深度勘察：为什么播放器没渲染出来
 * 用法：node tools/probe_play_page.js <播放页URL>
 *
 * 它会把三件事一次性摊开：
 *   ① 顶层文档里有什么（iframe / video / 可见的 script）；
 *   ② 视口正中（红点初始落点）命中的元素是谁，祖先链是什么；
 *   ③ 播放器 iframe 里那一页到底长什么样（含 body 开头 400 字、video 数、报错文本）。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BASE = "https://tvlive-relay.app.workbuddy.host";
const TARGET = process.argv[2];
const OUT = path.resolve(__dirname, "probe_out");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!TARGET) { console.log("用法：node tools/probe_play_page.js <播放页URL>"); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", "--user-data-dir=C:/WINDOWS/Temp/tvlive-p2-" + Date.now(),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1280,720", "--ignore-certificate-errors",
    "--autoplay-policy=no-user-gesture-required", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let wsUrl = null;
  proc.stderr.on("data", (b) => { const m = b.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) wsUrl = m[1]; });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) { console.log("无头浏览器未就绪"); process.exit(1); }

  const list = await (await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"))).json();
  const sock = new globalThis.WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error("ws")); });

  let id = 0; const pend = new Map(); const logs = []; const frames = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const t = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      if (t) logs.push("[" + m.params.type + "] " + t);
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      logs.push("[EXC] " + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    if (m.method === "Log.entryAdded") {
      const en = m.params.entry;
      if (en.level === "error") logs.push("[ERR] " + en.text + " " + (en.url || ""));
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: ((r.result.exceptionDetails.exception || {}).description) || r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

  const deepDump = `(function(){
    function d(el){
      if(!el) return null;
      var r = el.getBoundingClientRect();
      var ch=[], n=el.parentElement, i=0;
      while(n && i<10){ ch.push((n.tagName||'').toLowerCase()+(n.id?('#'+n.id):'')+((n.className&&typeof n.className==='string'&&n.className)?('.'+n.className.split(/\\s+/)[0]):'')); n=n.parentElement; i++; }
      return { tag:(el.tagName||'').toLowerCase(), id:el.id||'', cls:(typeof el.className==='string'?el.className:'').slice(0,70),
               kids: el.children?el.children.length:-1, rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],
               text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,150), chain:ch.join(' < ') };
    }
    var o = { url: location.href, title: document.title, vw: innerWidth, vh: innerHeight,
              bodyLen: document.body ? document.body.innerHTML.length : -1 };
    o.centerHit = d(document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2)));
    o.iframes = [];
    var fs2 = document.getElementsByTagName('iframe');
    for(var i=0;i<fs2.length;i++){
      var r2=fs2[i].getBoundingClientRect();
      var rec={ src:fs2[i].getAttribute('src'), rect:[Math.round(r2.left),Math.round(r2.top),Math.round(r2.width),Math.round(r2.height)] };
      try{ var d2=fs2[i].contentDocument; rec.sameOrigin=!!d2;
        if(d2){ rec.videos=d2.getElementsByTagName('video').length;
                rec.innerCenter=d(d2.elementFromPoint(Math.round(r2.width/2),Math.round(r2.height/2)));
                rec.innerBodyHead=d2.body?d2.body.innerHTML.replace(/\\s+/g,' ').slice(0,400):'(无body)';
                rec.innerTitle=d2.title; }
      }catch(e){ rec.sameOrigin='BLOCKED'; }
      o.iframes.push(rec);
    }
    o.videos = [];
    var vs=document.getElementsByTagName('video');
    for(var j=0;j<vs.length;j++) o.videos.push(d(vs[j]));
    o.visibleScripts=[];
    var ss=document.getElementsByTagName('script');
    for(var k=0;k<ss.length;k++){
      var rr=ss[k].getBoundingClientRect();
      if(rr.height>2||ss[k].offsetParent!==null){
        o.visibleScripts.push({ src:ss[k].getAttribute('src')||'(内联)', rect:[Math.round(rr.left),Math.round(rr.top),Math.round(rr.width),Math.round(rr.height)],
          head:(ss[k].textContent||'').replace(/\\s+/g,' ').trim().slice(0,180), parent:(ss[k].parentElement||{}).tagName||'' });
      }
    }
    // 页面里所有含 video / player / iframe 字样的容器，看看播放器该出现的位置有没有东西
    o.playerish = [];
    var all=document.querySelectorAll('[id*="play"],[class*="play"],[id*="player"],[class*="player"],[id*="video"],[class*="video"]');
    for(var q=0;q<all.length && q<25;q++) o.playerish.push(d(all[q]));
    return o;
  })()`;

  console.log("打开：" + BASE + "/api/embed?url=" + encodeURIComponent(TARGET));
  await send("Page.navigate", { url: BASE + "/api/embed?url=" + encodeURIComponent(TARGET) });

  // 等播放器 iframe 或 video 出现（最多 30 秒）
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const st = await ev("(function(){return {ifr:document.getElementsByTagName('iframe').length, vid:document.getElementsByTagName('video').length, body:document.body?document.body.innerHTML.length:-1};})()");
    if (st && st.body > 500 && (st.ifr > 0 || st.vid > 0)) break;
  }
  await sleep(4000);

  const dump = await ev(deepDump);
  fs.writeFileSync(path.join(OUT, "play_page_dump.json"), JSON.stringify(dump, null, 2), "utf8");
  console.log(JSON.stringify(dump, null, 2));

  console.log("\n" + "═".repeat(70));
  console.log("console / 异常（只留前 40 条）");
  console.log("═".repeat(70));
  logs.slice(0, 40).forEach((l) => console.log("  " + l.slice(0, 260)));

  // 抓 HTML 存盘
  for (const [nm, u] of [["play_direct.html", TARGET], ["play_embed.html", BASE + "/api/embed?url=" + encodeURIComponent(TARGET)]]) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
      const t = await r.text();
      fs.writeFileSync(path.join(OUT, nm), t, "utf8");
      console.log("  · " + nm + " " + r.status + " " + t.length + " 字节");
    } catch (e) { console.log("  ! " + nm + " 失败 " + e.message); }
  }

  for (const f of (dump && dump.iframes) || []) {
    if (!f.src) continue;
    const mm = String(f.src).match(/url=([^&]+)/);
    if (!mm) continue;
    const inner = decodeURIComponent(mm[1]);
    console.log("  · 播放器 iframe 目标：" + inner);
    try {
      const r = await fetch(BASE + "/api/embed?url=" + encodeURIComponent(inner), { headers: { "User-Agent": "Mozilla/5.0" } });
      const t = await r.text();
      fs.writeFileSync(path.join(OUT, "player_inner_embed.html"), t, "utf8");
      console.log("    → player_inner_embed.html " + r.status + " " + t.length + " 字节");
    } catch (e) { console.log("    抓取失败：" + e.message); }
    try {
      const r = await fetch(inner, { headers: { "User-Agent": "Mozilla/5.0" } });
      const t = await r.text();
      fs.writeFileSync(path.join(OUT, "player_inner_direct.html"), t, "utf8");
      console.log("    → player_inner_direct.html " + r.status + " " + t.length + " 字节");
    } catch (e) { console.log("    直连抓取失败：" + e.message); }
    break;
  }

  try { sock.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
})().catch((e) => { console.log("探针异常：" + e.stack); process.exit(1); });
