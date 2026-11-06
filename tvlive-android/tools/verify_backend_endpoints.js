/**
 * 后端链路验证脚本
 *
 * 目的：在没有模拟器/真机的情况下，用与 App 完全一致的编码规则，
 *      逐个复现 App 将要发出的网络请求，确认后端链路真正可用。
 *
 * 与 Kotlin 侧的对应关系：
 *   App 的 Backend.enc() = URLEncoder.encode(s,"UTF-8").replace("+","%20")
 *   本脚本的 urlEncode() 按同一规则实现（仅 A-Za-z0-9 . - * _ 不编码，其余按 UTF-8 逐字节 %XX，
 *   空格编为 + 后再替换为 %20），从而保证验证的是「App 真正会发的那个 URL」。
 */

const BASE = "https://tvlive-relay.app.workbuddy.host";

/** 精确复刻 Kotlin URLEncoder.encode(s,"UTF-8").replace("+","%20") */
function urlEncode(s) {
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9.\-*_]/.test(ch) && Buffer.byteLength(ch) === 1) {
      out += ch;
    } else {
      for (const b of Buffer.from(ch, "utf8")) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out.replace(/\+/g, "%20");
}

const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; log(`  [PASS] ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; log(`  [FAIL] ${name}${detail ? "  " + detail : ""}`); }
}

(async () => {
  log("═".repeat(70));
  log("后端链路验证（复现 App 实际请求）");
  log("═".repeat(70));

  // ── 1. 频道列表 ─────────────────────────────────────────────
  log("\n[1] 频道列表 " + BASE + "/api/channels");
  let channels = [];
  try {
    const r = await fetch(BASE + "/api/channels", { headers: { "User-Agent": "TvLive-Android/1.0" } });
    channels = await r.json();
    check("HTTP 200", r.status === 200, "status=" + r.status);
    check("返回数组且非空", Array.isArray(channels) && channels.length > 0, `count=${channels.length}`);
    // 允许 HLS(.m3u8) 与渐进式媒体(mp4/mp3 等)——两者 Media3 都能播；
    // 后端里的 "测试 · Big Buck Bunny (MP4)" 就是有意放置的渐进式测试源
    const playable = /\.(m3u8|mp4|mp3|aac|flv|ts)(\?|$)/i;
    const notPlayable = channels.filter((c) => !playable.test(c.url));
    check(
      "全部为可播格式(HLS/渐进式)",
      notPlayable.length === 0,
      notPlayable.length ? notPlayable.map((c) => c.name).join(",") : `HLS=${channels.filter((c) => /\.m3u8/i.test(c.url)).length} 渐进式=${channels.filter((c) => !/\.m3u8/i.test(c.url)).length}`
    );
    const groups = [...new Set(channels.map((c) => c.group))];
    check("含分组信息", groups.length > 1, "groups=" + groups.join("/"));
    log("  首个频道: " + channels[0].name + "  id=" + channels[0].id);
  } catch (e) {
    check("频道列表请求", false, e.message);
  }

  // ── 2. 配置（回放地址） ─────────────────────────────────────
  log("\n[2] 配置 " + BASE + "/api/config");
  let replayUrl = "";
  try {
    const r = await fetch(BASE + "/api/config");
    const cfg = await r.json();
    replayUrl = cfg.replayUrl || "";
    check("HTTP 200", r.status === 200, "status=" + r.status);
    check("返回 replayUrl", replayUrl.length > 0, replayUrl);
    check("后端版本号", !!cfg.version, "version=" + cfg.version);
  } catch (e) {
    check("配置请求", false, e.message);
  }

  // ── 3. 直播中继（用 App 的编码方式，对真实频道逐个试） ──────
  log("\n[3] 直播中继 /api/relay（编码规则与 App 一致）");
  let relayOk = 0, relayTry = 0;
  for (const ch of channels.slice(0, 8)) {
    relayTry++;
    const url = BASE + "/api/relay?url=" + urlEncode(ch.url);
    try {
      const r = await fetch(url, { headers: { "User-Agent": "TvLive-Android/1.0" } });
      const body = await r.text();
      const ok = r.status === 200 && body.includes("#EXTM3U");
      if (ok) relayOk++;
      log(`  ${ok ? "PASS" : "FAIL"} ${ch.name.padEnd(28)} http=${r.status} size=${body.length}`);
    } catch (e) {
      log(`  FAIL ${ch.name.padEnd(28)} 异常: ${e.message}`);
    }
  }
  check(
    `中继至少 1 台可播（实测 ${relayOk}/${relayTry}）`,
    relayOk > 0,
    relayOk > 0 ? `成功 ${relayOk} 台` : "全部失败！"
  );

  // ── 4. 回放内嵌代理 ────────────────────────────────────────
  log("\n[4] 回放内嵌代理 /api/embed");
  if (replayUrl) {
    const url = BASE + "/api/embed?url=" + urlEncode(replayUrl);
    log("  请求: " + url);
    try {
      const r = await fetch(url);
      const html = await r.text();
      check("HTTP 200", r.status === 200, "status=" + r.status);
      check("返回 HTML 页面", html.includes("<html") || html.includes("<!DOCTYPE"), `size=${html.length}`);
      // 详情页里的播放器 iframe 是否已被接管为经我们代理（这是回放能播的关键）
      const taken = /\/api\/embed\?url=/.test(html) && /xiaoca\.top/.test(html);
      check("播放器 iframe 已被接管", taken, taken ? "" : "未发现被接管的播放器 iframe");
    } catch (e) {
      check("回放页请求", false, e.message);
    }
  } else {
    check("回放页请求", false, "未取到 replayUrl，跳过");
  }

  // ── 5. 真实媒体分片可达性 ──────────────────────────────────
  // 说明：播放列表返回 200 只证明「清单可取」；决定能否出画面的是「媒体数据能否拿到」。
  //      多数 HLS 首层是 master playlist（内容仍是 #EXTM3U，里面指向子清单），
  //      因此需要递归向下，直到拿到非 #EXTM3U 的媒体数据为止。
  log("\n[5] 媒体分片可达性（拉真实视频数据）");

  /** 带超时的 GET：部分海外源响应很慢，必须设上限，否则整个验证会挂住 */
  async function get(url, ms = 12000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { signal: ac.signal });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, buf };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchMedia(url, depth) {
    const res = await get(url);
    const text = res.buf.toString("utf8");
    if (depth < 4 && text.startsWith("#EXTM3U")) {
      const lines = text.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
      if (lines.length) {
        const seg = lines[0];
        const next = seg.startsWith("http") ? seg : BASE + (seg.startsWith("/") ? seg : "/" + seg);
        return fetchMedia(next, depth + 1);
      }
    }
    return res;
  }

  let mediaOk = 0;
  const cands = channels.filter((c) => /\.m3u8/i.test(c.url)).slice(0, 3);
  for (const ch of cands) {
    try {
      const plUrl = BASE + "/api/relay?url=" + urlEncode(ch.url);
      const m = await fetchMedia(plUrl, 0);
      const isTs = m.buf[0] === 0x47;                                    // TS 分片同步字节
      const isMp4 = m.buf.slice(0, 64).includes(Buffer.from("ftyp"));    // fMP4
      const ok = m.status === 200 && m.buf.length > 20000 && (isTs || isMp4);
      if (ok) mediaOk++;
      log(
        `  ${ok ? "PASS" : "----"} ${ch.name.padEnd(28)} status=${m.status} size=${m.buf.length} 容器=${isTs ? "TS" : isMp4 ? "fMP4" : "非媒体"}`
      );
    } catch (e) {
      log(`  ---- ${ch.name.padEnd(28)} 异常: ${e.message}`);
    }
  }
  check(
    `至少 1 台能取到真实媒体分片（实测 ${mediaOk}/${cands.length}）`,
    mediaOk > 0,
    mediaOk > 0 ? `成功 ${mediaOk} 台` : "全部失败！"
  );

  log("\n" + "═".repeat(70));
  log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
  log("═".repeat(70));
  process.exit(fail > 0 ? 1 : 0);
})();
