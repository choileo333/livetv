// 直连 vs 中继对照测速：判断慢在「上游源」还是「中继链路」
// 用法: node tools/probe_direct_vs_relay.js
const https = require('https');
const http = require('http');
const SC = 'CICKFPDYZQ';
const BASE = 'https://tvlive-relay.app.workbuddy.host';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, rejectUnauthorized: false });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });

function req(url, timeoutMs, capBytes, extraHeaders) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let total = 0, done = false, r = null;
    const chunks = [];
    const finish = (status, total_, secs) => {
      if (done) return; done = true;
      try { if (r) r.destroy(); } catch (e) {}
      resolve({ status, total: total_ || 0, secs, text: Buffer.concat(chunks).toString('utf8') });
    };
    try {
      const mod = url.startsWith('https') ? https : http;
      r = mod.request(url, { agent: url.startsWith('https') ? httpsAgent : httpAgent, headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 TvLiveProbe/2.0' }, extraHeaders || {}), timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) { res.resume(); finish(res.statusCode, 0, (Date.now() - t0) / 1000); return; }
        res.on('data', (c) => { chunks.push(c); total += c.length; if (capBytes && total >= capBytes) finish(200, total, (Date.now() - t0) / 1000); });
        res.on('end', () => finish(200, total, (Date.now() - t0) / 1000));
        res.on('error', () => finish(-1, total, (Date.now() - t0) / 1000));
      });
      r.on('timeout', () => finish(-1, total, (Date.now() - t0) / 1000));
      r.on('error', () => finish(-1, total, (Date.now() - t0) / 1000));
      r.end();
    } catch (e) { finish(-1, 0, 0); }
  });
}

// 从一段 m3u8 文本里找第一个媒体分片 URL（解码后判断），以 base 解析
function pick(text, base, wantSub) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let dec = t; try { dec = decodeURIComponent(t); } catch (e) {}
    const isPl = /\.m3u8(?:\?|&|$)/i.test(dec);
    if (wantSub === isPl) return new URL(t, base).toString();
  }
  return null;
}

// 下钻到媒体分片（fetcher(url) → {status,text}），返回 {segUrl, durSec}
async function drill(plUrl, fetcher) {
  let cur = await fetcher(plUrl);
  if (cur.status !== 200) return { err: '清单' + cur.status };
  const base = plUrl;
  for (let depth = 0; depth < 3; depth++) {
    const dm = cur.text.match(/#EXTINF:([\d.]+)/);
    const segUrl = pick(cur.text, base, false);
    if (segUrl) return { segUrl, durSec: dm ? parseFloat(dm[1]) : 6 };
    const sub = pick(cur.text, base, true);
    if (!sub) return { err: '无分片' };
    cur = await fetcher(sub);
    if (cur.status !== 200) return { err: '子清单' + cur.status };
  }
  return { err: '层数超限' };
}

async function measure(name, rawUrl, relayed) {
  const url = relayed ? `${BASE}/api/relay?url=${encodeURIComponent(rawUrl)}&sharecode=${SC}` : rawUrl;
  const fetcher = async (u) => { const r = await req(u, 12000, 0); return { status: r.status, text: r.text }; };
  const d = await drill(url, fetcher);
  if (d.err) { console.log(`${name} [${relayed ? '中继' : '直连'}] → ${d.err}`); return; }
  const seg = await req(d.segUrl, 25000, 3 * 1024 * 1024);
  const mbps = seg.total > 10000 ? ((seg.total * 8) / seg.secs / 1e6).toFixed(2) : '0';
  console.log(`${name} [${relayed ? '中继' : '直连'}] → ${seg.status} ${seg.total}B ${(seg.secs).toFixed(2)}s ${mbps}Mbps (分片时长${d.durSec}s)`);
}

(async () => {
  const cases = [
    ['아리랑TV ', 'http://amdlive-ch01.ctnd.com.edgesuite.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8'],
    ['NBS     ', 'http://nbs.scdn.co.kr/nbs/nbs_1ch/playlist.m3u8'],
    ['대전MBC ', 'http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s1/playlist.m3u8'],
  ];
  // 대전MBC 换成真实 url 再跑 — 上面第三个仅占位，先只测前两个 + TV Chosun 作对照
  const cases2 = [
    ['아리랑TV ', 'http://amdlive-ch01.ctnd.com.edgesuite.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8'],
    ['TV조선  ', 'http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s1/playlist.m3u8'],
  ];
  for (const [n, u] of cases2) {
    await measure(n, u, true);
    await measure(n, u, false);
  }
})();
