// 精确复刻用户真实路径：打开首页 → 点「回放」→ 列表里点进视频 → 驱动播放器
// 用 CDP 跨帧执行（Runtime.evaluate + contextId），不受跨域限制，能深入任意嵌套层
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9334;
const BASE = "https://tvlive-relay.app.workbuddy.host";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

(async () => {
  const profile = path.join(os.tmpdir(), "cdp-flow-" + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + profile,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--mute-audio", "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ], { stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) { await sleep(400); }
  }
  if (!ver) { log("!! DevTools 未就绪"); chrome.kill(); process.exit(1); }
  log("[0] " + ver["Browser"]);

  const nr = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + "/")}`, { method: "PUT" });
  const tab = await nr.json();

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  // 维护「帧 ↔ 执行上下文」映射：executionContextCreated 事件里带 auxData.frameId
  // 注意：同帧导航会销毁旧上下文、新建上下文（不触发 executionContextsCleared），
  // 因此必须跟踪 executionContextDestroyed 并「用最新上下文覆盖」，否则会拿到已失效的 contextId
  const ctxByFrame = new Map(); // frameId -> contextId（最新）
  const frameByCtx = new Map(); // contextId -> frameId（反查，用于销毁时清理）
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.executionContextCreated") {
      const c = m.params.context, fid = c.auxData && c.auxData.frameId;
      if (fid) { ctxByFrame.set(fid, c.id); frameByCtx.set(c.id, fid); } // 覆盖为最新
    }
    if (m.method === "Runtime.executionContextDestroyed") {
      const cid = m.params.executionContextId, fid = frameByCtx.get(cid);
      if (fid && ctxByFrame.get(fid) === cid) ctxByFrame.delete(fid); // 只删「当前生效的那个」已销毁的情况
      frameByCtx.delete(cid);
    }
    if (m.method === "Runtime.executionContextsCleared") { ctxByFrame.clear(); frameByCtx.clear(); }
  });

  await new Promise((r) => ws.addEventListener("open", r));
  await send("Runtime.enable", {});
  await send("Page.enable", {});

  // 拉帧树：frameId -> {url, parentId}
  const frameTree = async () => {
    const r = await send("Page.getFrameTree", {});
    const out = [];
    const walk = (n) => { out.push({ id: n.frame.id, url: n.frame.url, parent: n.frame.parentId }); (n.childFrames || []).forEach(walk); };
    walk(r.result.frameTree);
    return out;
  };

  // 在「URL 含 sub 的帧」里执行表达式；上下文失效时自动等待重试
  const evalIn = async (sub, expr, retry = 6) => {
    for (let attempt = 0; attempt <= retry; attempt++) {
      const fr = (await frameTree()).filter((f) => f.url.includes(sub));
      for (const f of fr.reverse()) { // 取最内层的（后出现的通常是子帧）
        const cid = ctxByFrame.get(f.id);
        if (!cid) continue;
        const r = await send("Runtime.evaluate", { expression: expr, contextId: cid, returnByValue: true });
        if (r.error) continue;              // 上下文已失效 → 换下一个/重试
        const res = r.result;
        if (res && res.exceptionDetails) return { err: (res.exceptionDetails.exception || {}).description || "exception" };
        return { val: res && res.result ? res.result.value : undefined, url: f.url };
      }
      await sleep(500); // 等新上下文就绪
    }
    return { err: "no-context", frames: (await frameTree()).map((f) => f.url.slice(0, 70)) };
  };

  const dumpFrames = async (tag) => {
    const fs2 = await frameTree();
    log("   [" + tag + "] 帧数=" + fs2.length);
    fs2.forEach((f, i) => log("      " + i + " " + f.url.slice(0, 150)));
    return fs2;
  };

  // ── 步骤 1：首页 ────────────────────────────────────────
  await sleep(4000);
  log("[1] 首页帧结构"); await dumpFrames("1");

  // ── 步骤 2：点「回放」 ──────────────────────────────────
  const click = await evalIn("tvlive-relay.app.workbuddy.host/", `
    (function(){ var b=document.getElementById('btnModeReplay'); if(!b) return 'no-btn'; b.click(); return 'clicked'; })()
  `);
  log("[2] 点击「回放」 → " + JSON.stringify(click));
  await sleep(6000);
  log("[2] 切换后帧结构"); const f2 = await dumpFrames("2");

  // ── 步骤 3：在回放 iframe 里点进一个视频 ────────────────
  const targets = f2.filter((f) => f.url.includes("/api/embed") && f.url.includes("dodotv20"));
  log("[3] 回放站帧数=" + targets.length);
  if (!targets.length) { log("!! 回放站未加载"); }

  // 3a. 先只在帧内「读」链接，不做导航（导航会打断 evaluate 的返回值）
  let href = null, replayFrameId = null;
  for (const t of targets) {
    replayFrameId = t.id;
    const r = await evalIn(t.url.slice(0, 90), `
      (function(){
        var as=document.querySelectorAll('a[href*="shplay"]');
        return JSON.stringify({n:as.length, first: as.length? as[0].getAttribute('href').slice(0,140):''});
      })()
    `);
    log("[3a] 帧内链接探测 → " + JSON.stringify(r).slice(0, 240));
    if (r.val) { try { href = JSON.parse(r.val).first || null; } catch (e) {} }
    if (href) break;
  }

  // 3b. 用 Page.navigate 把这个帧导航到详情页（等价于用户点击该链接，DOM 结构完全相同）
  if (href) {
    let navUrl = href;
    if (!/^https?:/i.test(href)) {
      const base = targets[0].url;
      navUrl = new URL(href, base).toString();
    }
    log("[3b] 导航回放帧 → " + decodeURIComponent(navUrl).slice(0, 130));
    await send("Page.navigate", { frameId: replayFrameId, url: navUrl });
  } else {
    log("!! 没拿到详情页链接");
  }
  await sleep(9000);
  log("[3] 导航后帧结构"); const f3 = await dumpFrames("3");

  // ── 步骤 4：驱动播放器 ──────────────────────────────────
  const DRIVE = `(function(){
    var v=document.querySelector('video');
    if(!v) return JSON.stringify({note:'no video', videos:document.querySelectorAll('video').length});
    v.muted=true;
    try{ if(window.art&&art.play) art.play(); else v.play(); }catch(e){}
    return JSON.stringify({readyState:v.readyState, currentTime:+v.currentTime.toFixed(2),
      duration:(isNaN(v.duration)?'NaN':+v.duration.toFixed(1)), size:v.videoWidth+'x'+v.videoHeight,
      paused:v.paused, buffered:(v.buffered.length?+v.buffered.end(0).toFixed(1):0),
      src:String(v.src||'').slice(0,34), err:v.error?(v.error.code+':'+v.error.message):''});
  })()`;

  const playFrame = f3.find((f) => f.url.includes("xiaoca") && f.url.includes("/api/embed"));
  log("[4] 播放器帧=" + (playFrame ? playFrame.url.slice(0, 90) : "(未找到)"));
  if (!playFrame) { log("!! 播放器帧缺失，无法驱动"); }
  else {
    const key = playFrame.url.slice(0, 90);
    const t0 = Date.now();
    let best = null, ok = false;
    while (Date.now() - t0 < 60000) {
      const r = await evalIn(key, DRIVE);
      if (r.val) {
        let o; try { o = JSON.parse(r.val); } catch (e) { o = { raw: r.val }; }
        log("[" + Math.round((Date.now() - t0) / 1000) + "s] " + JSON.stringify(o));
        best = o;
        if (o.readyState === 4 && o.currentTime > 3 && o.size && o.size !== "0x0") { ok = true; break; }
      } else log("[" + Math.round((Date.now() - t0) / 1000) + "s] " + JSON.stringify(r).slice(0, 160));
      await sleep(1000);
    }
    log("");
    if (ok) {
      log("===== USER-PATH-E2E-CONFIRMED =====");
      log("用户路径实测：readyState=" + best.readyState + " currentTime=" + best.currentTime + "s duration=" + best.duration +
          " " + best.size + " buffered=" + best.buffered + "s src=" + best.src);
    } else {
      log("===== USER-PATH-E2E-NOT-CONFIRMED =====");
      log("最后状态: " + JSON.stringify(best));
    }
    ws.close(); chrome.kill(); await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    process.exit(ok ? 0 : 2);
  }

  ws.close(); chrome.kill(); await sleep(600);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(2);
})();
