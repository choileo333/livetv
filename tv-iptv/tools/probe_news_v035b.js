// 探针 v2：改用 iptv-org 维护的国家/分类播放列表（可靠），抓取候选新闻频道并深度探测。
const https = require('https');
const http = require('http');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: false });

function fetchSome(url, timeoutMs, capBytes) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const t0 = Date.now();
    const chunks = [];
    let total = 0, done = false, req = null, hard = null;
    const finish = (status, ct, reason) => {
      if (done) return; done = true;
      if (hard) clearTimeout(hard);
      try { if (req) req.destroy(); } catch (e) {}
      resolve({ status, ct: ct || '', total, secs: Math.max((Date.now() - t0) / 1000, 0.001), reason: reason || 'end', text: Buffer.concat(chunks).toString('utf8') });
    };
    try {
      req = mod.request(url, { method: 'GET', agent: mod === https ? httpsAgent : httpAgent, headers: { 'User-Agent': 'Mozilla/5.0 TvLiveProbe/2.0' }, timeout: timeoutMs }, (res) => {
        const ct = res.headers['content-type'] || '';
        if (res.statusCode !== 200) { res.resume(); finish(res.statusCode || 0, ct, 'http'); return; }
        res.on('data', (c) => { chunks.push(c); total += c.length; if (total >= capBytes) finish(200, ct, 'cap'); });
        res.on('end', () => finish(200, ct, 'end'));
        res.on('error', () => finish(200, ct, 'error'));
      });
      req.on('timeout', () => finish(-1, '', 'timeout'));
      req.on('error', () => finish(-1, '', 'error'));
      hard = setTimeout(() => finish(-1, '', 'timeout'), timeoutMs + 500);
      req.end();
    } catch (e) { finish(-1, '', 'error'); }
  });
}
function estKbps(r) { return Math.round((r.total * 8) / 1000 / r.secs); }
async function checkDeep(url, timeoutMs) {
  const CAP = 1500 * 1024; let u = url;
  for (let depth = 0; depth < 4; depth++) {
    const r = await fetchSome(u, Math.min(timeoutMs, 3000), 4096);
    if (r.status !== 200) return { state: 'dead', kbps: 0, reason: 'http' + r.status };
    if (/\.mp4(\?.*)?$/i.test(u) || /video\/mp4/i.test(r.ct)) return { state: 'ok', kbps: estKbps(r), reason: 'mp4' };
    if (!/#EXTM3U/i.test(r.text)) return { state: 'dead', kbps: 0, reason: 'not-hls' };
    const isMaster = /#EXT-X-STREAM-INF/i.test(r.text);
    const isMedia = /#EXTINF/i.test(r.text);
    const lines = r.text.split(/\r?\n/).map((x) => x.trim());
    let next = null, lastInf = 0, segDur = 0;
    for (const l of lines) {
      if (!l) continue;
      if (l.startsWith('#EXTINF')) { lastInf = parseFloat(l.slice(8).split(',')[0]) || 0; continue; }
      if (l.startsWith('#')) continue;
      next = l; segDur = lastInf; break;
    }
    if (!next) return { state: 'dead', kbps: 0, reason: 'no-url' };
    const abs = new URL(next, u).toString();
    if (isMedia && !isMaster) {
      const isLive = !/#EXT-X-ENDLIST/i.test(r.text);
      const pdts = []; const rePdt = /#EXT-X-PROGRAM-DATE-TIME:([^\r\n#]+)/g; let mp;
      while ((mp = rePdt.exec(r.text))) { const t = Date.parse(mp[1].trim()); if (!isNaN(t)) pdts.push(t); }
      if (isLive && pdts.length) { const ageSec = (Date.now() - Math.max.apply(null, pdts)) / 1000; if (ageSec > 300) return { state: 'dead', kbps: 0, reason: 'stale' + Math.round(ageSec) }; }
      const s = await fetchSome(abs, Math.min(timeoutMs, 5000), CAP);
      if (s.status !== 200) return { state: 'dead', kbps: 0, reason: 'seg' + s.status };
      const kbps = estKbps(s);
      if (s.reason === 'timeout' && s.total < 200 * 1024) return { state: 'dead', kbps, reason: 'seg-timeout' };
      if (s.reason === 'end' && segDur > 0) { const ratio = segDur / s.secs; return { state: ratio >= 1.3 ? 'ok' : ratio >= 0.9 ? 'slow' : 'dead', kbps, ratio: +ratio.toFixed(2) }; }
      return { state: kbps >= 1200 ? 'ok' : kbps >= 300 ? 'slow' : 'dead', kbps };
    }
    u = abs;
  }
  return { state: 'dead', kbps: 0, reason: 'depth' };
}
async function fetchM3U(url) {
  const r = await fetchSome(url, 10000, 4 * 1024 * 1024);
  if (r.status !== 200 || !/#EXTM3U/i.test(r.text)) { console.log(`[list-fail ${r.status}] ${url}`); return []; }
  const lines = r.text.split(/\r?\n/); const out = []; let name = '', logo = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF')) {
      const m = l.match(/tvg-logo="([^"]*)"/); if (m) logo = m[1];
      const n = l.split(',').slice(1).join(',').trim(); name = n;
    } else if (l && !l.startsWith('#')) { if (name) out.push({ name, url: l, logo }); name = ''; logo = ''; }
  }
  return out;
}
const PX = 'https://gh-proxy.com/https://raw.githubusercontent.com/';
const LISTS = {
  cn: PX + 'iptv-org/iptv/master/streams/cn.m3u',
  jp: PX + 'iptv-org/iptv/master/streams/jp.m3u',
  de: PX + 'iptv-org/iptv/master/streams/de.m3u',
  fr: PX + 'iptv-org/iptv/master/streams/fr.m3u',
  qa: PX + 'iptv-org/iptv/master/streams/qa.m3u',
  gb: PX + 'iptv-org/iptv/master/streams/gb.m3u',
  news: PX + 'iptv-org/iptv/master/categories/news.m3u',
  cn_cctv: PX + 'N0tf0und4o4/iptv-sources/main/cn_cctv.m3u8',
  cn_pay: PX + 'N0tf0und4o4/iptv-sources/main/cn_pay.m3u8',
  cn_all: PX + 'N0tf0und4o4/iptv-sources/main/cn_all.m3u8'
};
const WANT = [
  { kw: ['CCTV-1', 'CCTV 1', 'CCTV1'], tag: 'CCTV-1 综合' },
  { kw: ['CCTV-13', 'CCTV 13', '新闻'], tag: 'CCTV-13 新闻' },
  { kw: ['CCTV-4', '中文国际'], tag: 'CCTV-4 中文国际' },
  { kw: ['CGTN'], tag: 'CGTN' },
  { kw: ['凤凰', 'Phoenix', 'PHOENIX'], tag: '凤凰卫视' },
  { kw: ['NHK World', 'NHK'], tag: 'NHK World' },
  { kw: ['DW', 'Deutsche Welle'], tag: 'DW News' },
  { kw: ['France 24'], tag: 'France 24' },
  { kw: ['Al Jazeera'], tag: 'Al Jazeera' },
  { kw: ['BBC News', 'BBC'], tag: 'BBC News' },
  { kw: ['Sky News'], tag: 'Sky News' }
];
function matchTag(name) {
  const n = name.toLowerCase();
  for (const w of WANT) if (w.kw.some(k => n.includes(k.toLowerCase()))) return w.tag;
  return null;
}
async function main() {
  const collected = {};
  for (const [k, u] of Object.entries(LISTS)) {
    const c = await fetchM3U(u);
    console.log(`[list] ${k} -> ${c.length} 条`);
    for (const ch of c) {
      const tag = matchTag(ch.name);
      if (tag && !collected[tag]) collected[tag] = ch;
    }
  }
  const cands = Object.entries(collected).map(([tag, ch]) => ({ tag, ...ch }));
  console.log(`\n=== 命中候选 ${cands.length} 个，深度探测 ===\n`);
  const results = [];
  for (const c of cands) {
    const t0 = Date.now(); let res;
    try { res = await checkDeep(c.url, 6000); } catch (e) { res = { state: 'dead', kbps: 0, reason: 'err:' + e.message }; }
    const dt = Date.now() - t0;
    results.push({ ...c, ...res, dt });
    console.log(`${(c.tag + ' | ' + c.name).padEnd(40)} | ${res.state.toUpperCase().padEnd(4)} | ${String(res.kbps||0).padStart(6)}kbps | ${res.ratio||'-'} | ${res.reason||''} | ${dt}ms`);
    console.log(`      url: ${c.url}`);
  }
  console.log('\n=== 可播(ok/slow) ===');
  results.filter(r => r.state !== 'dead').forEach(r => console.log(`  [${r.tag}] ${r.name} | ${r.state} | ${r.kbps}kbps | ${r.url}`));
}
main();
