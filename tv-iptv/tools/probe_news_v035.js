// 一次性探针：从「每日检测」的中文直播源列表 + 硬编码全球优质新闻源，抓取候选 URL，
// 用与后端一致的深度探测（checkDeep）逐一验证：是否真能拉到分片、吞吐是否够流畅。
// 注意：本沙箱为「非中国」网络，故中国本土源（如 219.x / IPv4 内网）在此会 fail，
// 但那些源在「中国中继（上海腾讯云）」上是可达的——所以对中国源我们同时采信维护者的每日检测结果。
const https = require('https');
const http = require('http');

// —— 复刻后端 checkDeep（去掉中继 agent，用裸连接即可）——
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
      req = mod.request(url, {
        method: 'GET',
        agent: mod === https ? httpsAgent : httpAgent,
        headers: { 'User-Agent': 'Mozilla/5.0 TvLiveProbe/2.0' },
        timeout: timeoutMs
      }, (res) => {
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
  const CAP = 1500 * 1024;
  let u = url;
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
      const pdts = [];
      const rePdt = /#EXT-X-PROGRAM-DATE-TIME:([^\r\n#]+)/g;
      let mp;
      while ((mp = rePdt.exec(r.text))) { const t = Date.parse(mp[1].trim()); if (!isNaN(t)) pdts.push(t); }
      if (isLive && pdts.length) {
        const ageSec = (Date.now() - Math.max.apply(null, pdts)) / 1000;
        if (ageSec > 300) return { state: 'dead', kbps: 0, reason: 'stale' + Math.round(ageSec) };
      }
      const s = await fetchSome(abs, Math.min(timeoutMs, 5000), CAP);
      if (s.status !== 200) return { state: 'dead', kbps: 0, reason: 'seg' + s.status };
      const kbps = estKbps(s);
      if (s.reason === 'timeout' && s.total < 200 * 1024) return { state: 'dead', kbps, reason: 'seg-timeout' };
      if (s.reason === 'end' && segDur > 0) {
        const ratio = segDur / s.secs;
        return { state: ratio >= 1.3 ? 'ok' : ratio >= 0.9 ? 'slow' : 'dead', kbps, ratio: +ratio.toFixed(2) };
      }
      return { state: kbps >= 1200 ? 'ok' : kbps >= 300 ? 'slow' : 'dead', kbps };
    }
    u = abs;
  }
  return { state: 'dead', kbps: 0, reason: 'depth' };
}

// —— 抓取 m3u 列表，解析出 {name,url} ——
async function fetchM3U(url) {
  const r = await fetchSome(url, 8000, 2 * 1024 * 1024);
  if (r.status !== 200 || !/#EXTM3U/i.test(r.text)) return [];
  const lines = r.text.split(/\r?\n/);
  const out = [];
  let name = '', logo = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF')) {
      const m = l.match(/tvg-logo="([^"]*)"/); if (m) logo = m[1];
      const n = l.split(',').slice(1).join(',').trim();
      name = n;
    } else if (l && !l.startsWith('#')) {
      if (name) out.push({ name, url: l, logo });
      name = ''; logo = '';
    }
  }
  return out;
}

async function getCandidates() {
  const lists = [
    'https://raw.githubusercontent.com/N0tf0und4o4/iptv-sources/main/cn_cctv.m3u8',
    'https://raw.githubusercontent.com/N0tf0und4o4/iptv-sources/main/cn_pay.m3u8',
    'https://raw.githubusercontent.com/N0tf0und4o4/iptv-sources/main/cn_all.m3u8'
  ];
  const all = [];
  for (const u of lists) {
    try { const c = await fetchM3U(u); console.log(`[list] ${u} -> ${c.length} 条`); all.push(...c); }
    catch (e) { console.log(`[list-fail] ${u}: ${e.message}`); }
  }
  // 关键词筛选（新闻相关）
  const kw = ['新闻', 'CCTV', '央视', '凤凰', '资讯', '中文国际', 'CGTN', 'Phoenix', 'NHK', 'DW', 'France', 'Al Jazeera', '卫视'];
  const seen = new Set();
  const picked = [];
  for (const c of all) {
    const key = c.url;
    if (seen.has(key)) continue;
    const hit = kw.some(k => c.name.toUpperCase().includes(k.toUpperCase()));
    if (hit) {
      // 过滤掉明显非新闻的卫视（除凤凰/资讯/新闻外，纯卫视如湖南卫视不算新闻）
      const isNews = /新闻|资讯|凤凰|CGTN|CCTV|央视|中文国际|Phoenix|NHK|DW|France|Al Jazeera/i.test(c.name);
      if (isNews) { seen.add(key); picked.push(c); }
    }
  }
  return picked;
}

async function main() {
  const cands = await getCandidates();
  // 硬编码全球优质新闻（iptv-org / 官方 CDN）
  const hard = [
    { name: 'CGTN (English) 新闻', url: 'https://english-livebkali.cgtn.com/live/encgtn_0.m3u8', logo: '' },
    { name: 'NHK World (Japan)', url: 'https://nhkwtglobal-i.akamaihd.net/hls/live/2042328/nhkwtglobal/index.m3u8', logo: '' },
    { name: 'DW News (Germany)', url: 'https://dwamdman-lh.akamaihd.net/i/dwstream_1@487477/master.m3u8', logo: '' },
    { name: 'France 24 English', url: 'https://f24hls-i.akamaihd.net/hls/live/2035767/f24_en/master.m3u8', logo: '' },
    { name: 'Al Jazeera English', url: 'https://live-hls-web-aje.getaj.net/Source1_LS.m3u8', logo: '' }
  ];
  const total = [...cands, ...hard];
  console.log(`\n=== 候选新闻频道 ${total.length} 个，开始深度探测（沙箱非中国网络）===\n`);
  const results = [];
  for (const c of total) {
    const t0 = Date.now();
    let res;
    try { res = await checkDeep(c.url, 6000); } catch (e) { res = { state: 'dead', kbps: 0, reason: 'err:' + e.message }; }
    const dt = Date.now() - t0;
    results.push({ name: c.name, url: c.url, ...res, dt });
    console.log(`${(c.name).padEnd(28)} | ${res.state.toUpperCase().padEnd(4)} | ${String(res.kbps||0).padStart(6)}kbps | ${res.ratio||'-'} | ${res.reason||''} | ${dt}ms`);
  }
  console.log('\n=== 可播(ok/slow) ===');
  results.filter(r => r.state !== 'dead').forEach(r => console.log(`  ${r.name} | ${r.state} | ${r.kbps}kbps | ${r.url}`));
  console.log('\n=== 中国本土源（沙箱 fail 但中继可达，需用户自测） ===');
  results.filter(r => r.state === 'dead' && /(219\.|2409:|58\.|121\.|61\.|live\.fengshows|cntv|cctv)/i.test(r.url)).forEach(r => console.log(`  ${r.name} | ${r.url}`));
}
main();
