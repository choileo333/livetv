// 一次性探测脚本：复用后端 server.js 的「深度探测」逻辑，对一批候选韩国台做真实拉流测吞吐。
// 目的：在加入频道表之前先验证「能返回 HLS 且分片可流畅下载」，避免加入死链/冻结播放列表。
// 用法：node probe_kr_v034.js
const http = require('http');
const https = require('https');

const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 32 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: false });

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
        method: 'GET', agent: mod === https ? agentHttps : agentHttp,
        headers: { 'User-Agent': 'Mozilla/5.0 TvLiveProbe/2.0' }, timeout: timeoutMs
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
      const rePdt = /#EXT-X-PROGRAM-DATE-TIME:([^\r\n#]+)/g; let mp;
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

const CANDIDATES = [
  // —— 对照组（已在列表、已知可达，用来验证探测脚本本身）——
  { tag: 'CTRL TVChosun', url: 'http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s1/playlist.m3u8' },
  { tag: 'CTRL EBS1TV', url: 'http://ebsonairios.ebs.co.kr/groundwavetablet500k/tablet500k/playlist.m3u8' },
  { tag: 'CTRL FGTV', url: 'https://fgtvlive.fgtv.com/smil:fgtv.smil/playlist.m3u8' },
  // —— 候选：与已工作频道同 CDN 族（streamlock / nowcdn / akamaized / cloudfront / edgesuite）——
  { tag: 'MBC Gwangju 1080p', url: 'https://media.kjmbc.co.kr/hls/live/stream/playlist.m3u8' },
  { tag: 'MBC Gangwon 1080p', url: 'http://123.254.93.7:1935/tvlive/livestream2/playlist.m3u8' },
  { tag: 'MBC Yeosu 1080p', url: 'https://5c3639aa99149.streamlock.net/live_TV/tv/playlist.m3u8' },
  { tag: 'MBC Jeonju 450p', url: 'https://5ee9633b25727.streamlock.net/jmbc_tv/_definst_/jmbc_tv.stream/playlist.m3u8' },
  { tag: 'MBC Mokpo 720p', url: 'http://vod.mpmbc.co.kr:1935/live/encoder-tv/playlist.m3u8' },
  { tag: 'MBC Busan 360p', url: 'https://stream.bsmbc.com/livetv/BusanMBC_TV_onairstream/playlist.m3u8' },
  { tag: 'MBC Jeju 352p', url: 'https://wowza.jejumbc.com/live/tv_jejumbc/playlist.m3u8' },
  { tag: 'SBS KNN 1080p', url: 'https://stream1.knn.co.kr/hls/9ly4534y7dm2xfa123r2_tv/index.m3u8' },
  { tag: 'SBS KBC 1080p', url: 'https://vod.ikbc.co.kr/KBCTV/tv/playlist.m3u8' },
  { tag: 'SBS TBC 540p', url: 'http://203.251.91.122:1935/on-air-Backup/tv/playlist.m3u8' },
  { tag: 'SBS JIBS 720p', url: 'http://123.140.197.22/stream/1/play.m3u8' },
  { tag: 'SBS JTV 406p', url: 'http://61.85.197.53:1935/jtv_live/myStream/playlist.m3u8' },
  { tag: 'SBS UBC 540p', url: 'https://stream.ubc.co.kr/hls/ubctvstream/index.m3u8' },
  { tag: 'SBS G1 360p', url: 'http://61.82.49.4:1935/live/_definst_/tv.stream/playlist.m3u8' },
  { tag: 'OBS Gyeongin 540p', url: 'https://vod.obs.co.kr:444/live/obsstream1/tv.stream/playlist.m3u8' },
  { tag: 'BTN TV 1080p', url: 'https://btn.nowcdn.co.kr/btn/btnlive2m/playlist.m3u8' },
  { tag: 'BBS Buddhist 1080p', url: 'http://bbstv.clouducs.com:1935/bbstv-live/livestream/playlist.m3u8' },
  { tag: 'GoodTV 1080p', url: 'http://mobliestream.c3tv.com:1935/live/goodtv.sdp/playlist.m3u8' },
];

(async () => {
  const queue = CANDIDATES.slice();
  const results = {};
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      try { results[c.tag] = await checkDeep(c.url, 6000); }
      catch (e) { results[c.tag] = { state: 'dead', kbps: 0, reason: 'exc' }; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log('=== 探测结果（sandbox 网络，仅作可达性/质量初筛；最终以用户 /api/check 为准）===');
  for (const c of CANDIDATES) {
    const r = results[c.tag] || {};
    console.log(`${c.tag.padEnd(20)} -> ${r.state || '?'}  kbps=${(r.kbps||0)}  ratio=${r.ratio||'-'}  reason=${r.reason||''}`);
  }
})();
