// 探测国内新闻源候选：复用后端深度探测逻辑（跟到真实分片测吞吐 + 冻结假直播识别）
const https = require("https");
const http = require("http");

const ha = new http.Agent({ keepAlive: true, maxSockets: 32 });
const hsa = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: false });

function fetchSome(url, timeoutMs, capBytes) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const t0 = Date.now();
    const chunks = [];
    let total = 0, done = false, req, timer;
    const finish = (status, ct, reason) => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      try { if (req) req.destroy(); } catch (e) {}
      resolve({ status, ct: ct || "", total, secs: Math.max((Date.now() - t0) / 1000, 0.001), reason, text: Buffer.concat(chunks).toString("utf8") });
    };
    try {
      req = mod.request(url, { method: "GET", agent: mod === https ? hsa : ha, headers: { "User-Agent": "Mozilla/5.0", "Referer": url }, timeout: timeoutMs }, (res) => {
        const ct = res.headers["content-type"] || "";
        if (res.statusCode !== 200) { res.resume(); finish(res.statusCode, ct, "http"); return; }
        res.on("data", (c) => { chunks.push(c); total += c.length; if (total >= capBytes) finish(200, ct, "cap"); });
        res.on("end", () => finish(200, ct, "end"));
        res.on("error", () => finish(200, ct, "err"));
      });
      req.on("timeout", () => finish(-1, "", "timeout"));
      req.on("error", (e) => finish(-1, "", e.code || "err"));
      timer = setTimeout(() => finish(-1, "", "timeout"), timeoutMs + 800);
      req.end();
    } catch (e) { finish(-1, "", "err"); }
  });
}

async function checkDeep(url, timeoutMs) {
  const CAP = 1500 * 1024;
  let u = url;
  for (let depth = 0; depth < 4; depth++) {
    const r = await fetchSome(u, Math.min(timeoutMs, 3000), 4096);
    if (r.status !== 200) return { state: "dead", rs: "http" + r.status };
    if (!/#EXTM3U/i.test(r.text)) return { state: "dead", rs: "noHls:" + r.text.slice(0, 40) };
    const isMaster = /#EXT-X-STREAM-INF/i.test(r.text);
    const hasSegs = /#EXTINF/i.test(r.text);
    const lines = r.text.split(/\r?\n/).map((x) => x.trim());
    let next = null, segDur = 0;
    for (const l of lines) {
      if (!l) continue;
      if (l.startsWith("#EXTINF")) { segDur = parseFloat(l.slice(8).split(",")[0]) || 0; continue; }
      if (l.startsWith("#")) continue;
      next = l; break;
    }
    if (!next) return { state: "dead", rs: "nourl" };
    const abs = new URL(next, u).toString();
    if (hasSegs && !isMaster) {
      const s = await fetchSome(abs, Math.min(timeoutMs, 5000), CAP);
      if (s.status !== 200) return { state: "dead", rs: "seg" + s.status };
      const kbps = Math.round((s.total * 8) / 1000 / s.secs);
      if (s.reason === "end" && segDur > 0) {
        const ratio = segDur / s.secs;
        return { state: ratio >= 1.3 ? "ok" : ratio >= 0.9 ? "slow" : "dead", kbps, ratio: +ratio.toFixed(2) };
      }
      return { state: kbps >= 1200 ? "ok" : kbps >= 300 ? "slow" : "dead", kbps };
    }
    u = abs;
  }
  return { state: "dead", rs: "depth" };
}

const cands = [
  // 现有（应已失效，确认一下）
  ["[现有]163 凤凰 27.41.245.32", "http://27.41.245.32:801/hls/205/index.m3u8"],
  ["[现有]164 CCTV13 hebtv", "https://event.pull.hebtv.com/jishi/cp1.m3u8"],
  // CCTV-13 候选
  ["CCTV13 A go.bkpcp.top", "http://go.bkpcp.top/mg/cctv13"],
  ["CCTV13 B 74.91.26.218", "http://74.91.26.218:82/live/cctv13hd.m3u8"],
  // 凤凰中文台 候选
  ["凤凰 E chinamobile", "http://223.110.245.139/ott.js.chinamobile.com/PLTV/3/224/3221226922/index.m3u8"],
  ["凤凰 F 125.210.152.18", "http://125.210.152.18:9090/live/FHZW_1200.m3u8"],
  // 备份：凤凰资讯
  ["凤凰资讯 F 125.210.152.18", "http://125.210.152.18:9090/live/FHZX_1200.m3u8"],
];

(async () => {
  for (const [name, u] of cands) {
    const t0 = Date.now();
    let r;
    try { r = await checkDeep(u, 6000); } catch (e) { r = { state: "dead", rs: "err:" + e.message }; }
    console.log(name.padEnd(24), "|", String(r.state).toUpperCase().padEnd(4), "|", String(r.kbps || 0).padStart(6), "kbps |", r.ratio || "-", "|", r.rs || "", "|", Date.now() - t0, "ms");
    console.log("    ", u);
  }
})();
