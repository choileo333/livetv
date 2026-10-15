// 只列出精准命中的候选（含 URL），不探测，便于人工挑选正确频道/正确语言版本。
const https = require('https');
const http = require('http');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: false });
function fetchSome(url, timeoutMs, capBytes) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const chunks = []; let total = 0, done = false, req = null, hard = null;
    const finish = (status, ct, reason) => { if (done) return; done = true; if (hard) clearTimeout(hard); try { if (req) req.destroy(); } catch (e) {} resolve({ status, ct: ct || '', total, secs: 0.001, reason: reason || 'end', text: Buffer.concat(chunks).toString('utf8') }); };
    try {
      req = mod.request(url, { method: 'GET', agent: mod === https ? httpsAgent : httpAgent, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: timeoutMs }, (res) => {
        const ct = res.headers['content-type'] || '';
        if (res.statusCode !== 200) { res.resume(); finish(res.statusCode || 0, ct, 'http'); return; }
        res.on('data', (c) => { chunks.push(c); total += c.length; if (total >= capBytes) finish(200, ct, 'cap'); });
        res.on('end', () => finish(200, ct, 'end')); res.on('error', () => finish(200, ct, 'error'));
      });
      req.on('timeout', () => finish(-1, '', 'timeout')); req.on('error', () => finish(-1, '', 'error'));
      hard = setTimeout(() => finish(-1, '', 'timeout'), timeoutMs + 500); req.end();
    } catch (e) { finish(-1, '', 'error'); }
  });
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
  cn_cctv: PX + 'N0tf0und4o4/iptv-sources/main/cn_cctv.m3u8',
  cn_pay: PX + 'N0tf0und4o4/iptv-sources/main/cn_pay.m3u8',
  jp: PX + 'iptv-org/iptv/master/streams/jp.m3u',
  de: PX + 'iptv-org/iptv/master/streams/de.m3u',
  fr: PX + 'iptv-org/iptv/master/streams/fr.m3u',
  qa: PX + 'iptv-org/iptv/master/streams/qa.m3u'
};
// 精准模式：只保留「明确是某频道且是英文/主频道」的条目
const PATTERNS = [
  { list: 'cn_cctv', re: /CCTV[- ]?1|新闻|中文国际|CCTV-13|CCTV-4/i },
  { list: 'cn_pay', re: /凤凰/i },
  { list: 'jp', re: /NHK World/i },
  { list: 'de', re: /DW\s*\(English\)|DW News|Deutsche Welle/i },
  { list: 'fr', re: /France 24\s*\(English\)/i },
  { list: 'qa', re: /Al Jazeera\s*\(English\)|Al Jazeera\b/i }
];
async function main() {
  for (const [k, u] of Object.entries(LISTS)) {
    const c = await fetchM3U(u);
    console.log(`\n===== ${k} (${c.length}) =====`);
    const pat = PATTERNS.find(p => p.list === k);
    if (pat) {
      c.filter(ch => pat.re.test(ch.name)).forEach(ch => console.log(`  ${ch.name}\n    ${ch.url}`));
    }
  }
}
main();
