/**
 * verify_referrer_chain.js —— 验证「回放 iframe 的 referrerpolicy 决定播放器能否拿到视频流」
 *
 * 背景（v0.3.13 修复的问题）：
 *   回放站的视频流地址做了防盗链，必须带 Referer: https://xiaoca.top/ 才返回 200，不带则 403。
 *   而 iframe 的 referrerpolicy 属性会被其内部所有子文档（含跨域播放器 iframe）继承，
 *   旧写法 no-referrer 会把整条链路的 Referer 全部剥掉 → 播放器 403 黑屏。
 *
 * 本脚本用两个本地端口 1:1 复刻真实链路，实测浏览器到底发了什么 Referer：
 *   A(8801) = 我们的应用（顶层页 + 经代理的第三方页，同源）
 *   B(8802) = 第三方播放器（跨域子框架，对应 xiaoca.top）
 *   链路： top(A) --iframe[referrerpolicy=X]--> mid(A) --iframe--> grand(B) --fetch--> A/report
 *   观测 A/report 收到的 Referer：
 *     · rp=no-referrer                     → 预期「空」     （= 真实场景里流服务器看到的，会 403）
 *     · rp=strict-origin-when-cross-origin → 预期 http://127.0.0.1:8802/  （= 真实场景 https://xiaoca.top/，放行）
 *
 * 用法：
 *   1) node tools/verify_referrer_chain.js          # 起服务（前台，Ctrl+C 结束）
 *   2) 另开终端用 Chrome 无头取结果：
 *      chrome --headless=new --dump-dom --virtual-time-budget=6000 \
 *             "http://127.0.0.1:8801/top?rp=no-referrer"
 *      chrome --headless=new --dump-dom --virtual-time-budget=6000 \
 *             "http://127.0.0.1:8801/top?rp=strict-origin-when-cross-origin"
 */
const http = require("http");

const A_PORT = 8801; // 我们的应用
const B_PORT = 8802; // 第三方播放器
const B_ORIGIN = `http://127.0.0.1:${B_PORT}`;

// 记录观测结果：report = 播放器跨域请求时带上的 Referer；grand = mid→grand 文档请求带上的 Referer
const stats = { report: {}, grand: {} };
// 每打开一次顶层页就清空上次观测，避免跨用例串味
const resetStats = () => { stats.report = {}; stats.grand = {}; };

const html = (body) => ({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
const json = (res, obj) => {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
};

// —— A：模拟我们的应用（顶层页 + 同源代理页）——
const srvA = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${A_PORT}`);

  // 顶层页：带一个可指定 referrerpolicy 的 iframe 指向同源代理页
  if (u.pathname === "/top") {
    const rp = u.searchParams.get("rp") || "";
    resetStats();
    const attr = rp ? ` referrerpolicy="${rp}"` : "";
    res.writeHead(200, html());
    return res.end(`<!doctype html><meta charset="utf-8"><title>top</title>
<iframe id="mid" src="/mid"${attr} width="700" height="60"></iframe>
<pre id="out">waiting...</pre>
<script>
var RP = ${JSON.stringify(rp)};
function poll(){
  fetch("/stats").then(function(r){return r.json()}).then(function(j){
    if (j.done) {
      document.getElementById("out").textContent =
        "RESULT rp=" + RP +
        " | 播放器跨域请求带的Referer=" + JSON.stringify(j.report.referer) +
        " | 代理页->播放器 文档Referer=" + JSON.stringify(j.grand.docReferrer);
      return;
    }
    setTimeout(poll, 150);
  }).catch(function(){ setTimeout(poll, 150); });
}
poll();
</script>`);
  }

  // 对照实验：只嵌一层跨域 iframe（验证 referrerpolicy 属性本身是否生效）
  if (u.pathname === "/top1") {
    const rp = u.searchParams.get("rp") || "";
    resetStats();
    const attr = rp ? ` referrerpolicy="${rp}"` : "";
    res.writeHead(200, html());
    return res.end(`<!doctype html><meta charset="utf-8"><title>top1</title>
<iframe src="${B_ORIGIN}/grand"${attr} width="600" height="40"></iframe>
<pre id="out">waiting...</pre>
<script>
var RP = ${JSON.stringify(rp)};
function poll(){
  fetch("/stats").then(function(r){return r.json()}).then(function(j){
    if (j.done) {
      document.getElementById("out").textContent =
        "RESULT1 rp=" + RP + " | 文档Referer=" + JSON.stringify(j.grand.docReferrer);
      return;
    }
    setTimeout(poll, 150);
  }).catch(function(){ setTimeout(poll, 150); });
}
poll();
</script>`);
  }

  // 同源代理页（对应我们的 /api/embed）：内部再嵌一个跨域的第三方播放器
  if (u.pathname === "/mid") {
    res.writeHead(200, html());
    return res.end(`<!doctype html><meta charset="utf-8"><title>mid</title>
<iframe src="${B_ORIGIN}/grand" width="600" height="40"></iframe>`);
  }

  // 记录「播放器跨域请求」时带上的 Referer（真实场景 = 流服务器看到的 Referer）
  if (u.pathname === "/report") {
    stats.report.referer = req.headers.referer || "(无 Referer)";
    return json(res, { ok: true, referer: stats.report.referer });
  }
  // 记录「代理页 -> 播放器」文档请求时带上的 Referer
  if (u.pathname === "/grandreport") {
    stats.grand.docReferrer = u.searchParams.get("ref");
    stats.grand.done = true; // 用独立标志，避免 Referer 为空串时误判为「还没回来」
    return json(res, { ok: true });
  }
  if (u.pathname === "/stats") return json(res, { done: !!stats.grand.done, ...stats });
  res.writeHead(404); res.end("nf");
});

// —— B：模拟第三方播放器（跨域）——
const srvB = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${B_PORT}`);
  if (u.pathname === "/grand") {
    res.writeHead(200, html());
    return res.end(`<!doctype html><meta charset="utf-8"><title>grand</title><body>grand
<script>
// ① 回报本页收到的文档 Referer（由 mid 的 referrerpolicy 决定）
fetch("http://127.0.0.1:${A_PORT}/grandreport?ref=" + encodeURIComponent(document.referrer));
// ② 发起跨域请求（对应播放器去流服务器取 m3u8）→ 由本页继承来的策略决定 Referer
fetch("http://127.0.0.1:${A_PORT}/report").catch(function(){});
</script></body>`);
  }
  res.writeHead(404); res.end("nf");
});

srvA.listen(A_PORT, "127.0.0.1", () => console.log(`[A] app    http://127.0.0.1:${A_PORT}/top?rp=...`));
srvB.listen(B_PORT, "127.0.0.1", () => console.log(`[B] player ${B_ORIGIN}/grand`));
