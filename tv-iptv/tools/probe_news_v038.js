const https = require('https'), http = require('http');
const ha = new http.Agent({ keepAlive: true, maxSockets: 32 });
const hsa = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: false });
function fs(url, to, cap) {
  return new Promise(r => {
    const m = url.startsWith('https') ? https : http;
    const t0 = Date.now(); const ch = []; let tot = 0, d = false, req, h;
    const fin = (s, ct, rs) => { if (d) return; d = true; if (h) clearTimeout(h); try { if (req) req.destroy(); } catch (e) {} r({ s, ct: ct || '', tot, secs: Math.max((Date.now() - t0) / 1000, .001), rs, text: Buffer.concat(ch).toString('utf8') }); };
    try {
      req = m.request(url, { method: 'GET', agent: m === https ? hsa : ha, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: to }, res => {
        const ct = res.headers['content-type'] || '';
        if (res.statusCode !== 200) { res.resume(); fin(res.statusCode, ct, 'http'); return; }
        res.on('data', c => { ch.push(c); tot += c.length; if (tot >= cap) fin(200, ct, 'cap'); });
        res.on('end', () => fin(200, ct, 'end')); res.on('error', () => fin(200, ct, 'err'));
      });
      req.on('timeout', () => fin(-1, '', 'to')); req.on('error', () => fin(-1, '', 'err'));
      h = setTimeout(() => fin(-1, '', 'to'), to + 500); req.end();
    } catch (e) { fin(-1, '', 'err'); }
  });
}
async function checkDeep(url, to) {
  const CAP = 1500 * 1024; let u = url;
  for (let d = 0; d < 4; d++) {
    const r = await fs(u, Math.min(to, 3000), 4096);
    if (r.s !== 200) return { state: 'dead', rs: 'http' + r.s };
    if (!/#EXTM3U/i.test(r.text)) return { state: 'dead', rs: 'noHls' };
    const im = /#EXT-X-STREAM-INF/i.test(r.text), ia = /#EXTINF/i.test(r.text);
    const lines = r.text.split(/\r?\n/).map(x => x.trim()); let nx = null, li = 0, sd = 0;
    for (const l of lines) { if (!l) continue; if (l.startsWith('#EXTINF')) { li = parseFloat(l.slice(8).split(',')[0]) || 0; continue; } if (l.startsWith('#')) continue; nx = l; sd = li; break; }
    if (!nx) return { state: 'dead', rs: 'nourl' };
    const abs = new URL(nx, u).toString();
    if (ia && !im) {
      const s = await fs(abs, Math.min(to, 5000), CAP);
      if (s.s !== 200) return { state: 'dead', rs: 'seg' + s.s };
      const k = Math.round(s.tot * 8 / 1000 / s.secs);
      if (s.rs === 'end' && sd > 0) { const ratio = sd / s.secs; return { state: ratio >= 1.3 ? 'ok' : ratio >= 0.9 ? 'slow' : 'dead', kbps: k, ratio: +ratio.toFixed(2) }; }
      return { state: k >= 1200 ? 'ok' : k >= 300 ? 'slow' : 'dead', kbps: k };
    }
    u = abs;
  }
  return { state: 'dead', rs: 'depth' };
}
const list = [
  ['DW English (Amagi)', 'https://amg01644-amg01644c1-amgplt0343.playout.now3.amagi.tv/ts-eu-w1-n2/playlist/amg01644-amg01644c1-amgplt0343/playlist.m3u8'],
  ['DW English (Akamai)', 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/master.m3u8'],
  ['France24 English', 'https://live.france24.com/hls/live/2037222/F24_EN_HI_HLS/master_5000.m3u8'],
  ['France24 English -b', 'https://live.france24.com/hls/live/2037222-b/F24_EN_HI_HLS/master_5000.m3u8']
];
(async () => { for (const [n, u] of list) { const t0 = Date.now(); let r; try { r = await checkDeep(u, 6000); } catch (e) { r = { state: 'dead', rs: 'err' }; } console.log(n.padEnd(22), '|', r.state.toUpperCase().padEnd(4), '|', String(r.kbps || 0).padStart(6), 'kbps |', r.ratio || '-', '|', r.rs || '', '|', Date.now() - t0, 'ms'); console.log('   ', u); } })();
