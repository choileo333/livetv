// 全量测速探针（走真实用户链路：线上中继 + sharecode）。
// 用法: node tools/probe_speed_2026-11-22.js [并发数]
// 输出: 每台 playlist 状态 + 分片吞吐 Mbps + ratio(分片耗时/分片时长)，ratio>1 即会卡顿。
// relay:false 的台跳过中继测试（它们设计上只在本机直连，云端测不了）。
const https = require('https');
const http = require('http');

const BASE = 'https://tvlive-relay.app.workbuddy.host';
const SC = 'CICKFPDYZQ';
const agent = new https.Agent({ keepAlive: true, maxSockets: 16, rejectUnauthorized: false });

function req(url, timeoutMs, capBytes) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let total = 0, done = false, r = null;
    const chunks = [];
    const finish = (status, ct, total_, secs) => {
      if (done) return; done = true;
      try { if (r) r.destroy(); } catch (e) {}
      resolve({ status, ct: ct || '', total: total_ || 0, secs, text: Buffer.concat(chunks).toString('utf8') });
    };
    try {
      r = https.request(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0 TvLiveProbe/2.0' }, timeout: timeoutMs }, (res) => {
        const ct = res.headers['content-type'] || '';
        if (res.statusCode !== 200) { res.resume(); finish(res.statusCode, ct, 0, (Date.now() - t0) / 1000); return; }
        res.on('data', (c) => { chunks.push(c); total += c.length; if (capBytes && total >= capBytes) finish(200, ct, total, (Date.now() - t0) / 1000); });
        res.on('end', () => finish(200, ct, total, (Date.now() - t0) / 1000));
        res.on('error', () => finish(-1, ct, total, (Date.now() - t0) / 1000));
      });
      r.on('timeout', () => finish(-1, '', total, (Date.now() - t0) / 1000));
      r.on('error', () => finish(-1, '', total, (Date.now() - t0) / 1000));
      r.end();
    } catch (e) { finish(-1, '', 0, 0); }
  });
}

function firstSegUrl(text, base) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    let dec = t; try { dec = decodeURIComponent(t); } catch (e) {}
    if (t && !t.startsWith('#') && !/\.m3u8(?:\?|&|$)/i.test(dec)) return new URL(t, base).toString();
  }
  return null;
}

function firstSubPl(text, base) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    let dec2 = t; try { dec2 = decodeURIComponent(t); } catch (e) {}
    if (t && !t.startsWith('#') && /\.m3u8(?:\?|&|$)/i.test(dec2)) return new URL(t, base).toString();
  }
  return null;
}

async function probe(ch) {
  const enc = encodeURIComponent(ch.url);
  let pl = await req(`${BASE}/api/relay?url=${enc}&sharecode=${SC}`, 12000, 0);
  if (pl.status !== 200) return { id: ch.id, name: ch.name, group: ch.group, pl: pl.status, verdict: '清单挂', mbps: 0 };
  const base = `${BASE}/api/relay?url=${enc}&sharecode=${SC}`;
  // 沿清单链下钻（变体子清单最多 3 层），直到拿到真正的媒体分片
  let segUrl = null, dur = 6, depth = 0, cur = pl;
  while (depth < 3) {
    const d = (cur.text.match(/#EXTINF:([\d.]+)/) || [])[1];
    if (d) dur = parseFloat(d);
    segUrl = firstSegUrl(cur.text, base);
    if (segUrl) break;
    const sub = firstSubPl(cur.text, base);
    if (!sub) break;
    cur = await req(sub, 12000, 0);
    if (cur.status !== 200) return { id: ch.id, name: ch.name, group: ch.group, pl: 200, verdict: `子清单挂(${cur.status})`, mbps: 0 };
    depth++;
  }
  if (!segUrl) return { id: ch.id, name: ch.name, group: ch.group, pl: 200, verdict: '清单无分片', mbps: 0 };
  const seg = await req(segUrl, 20000, 2.5 * 1024 * 1024);
  if (seg.status !== 200 || seg.total < 10000) return { id: ch.id, name: ch.name, group: ch.group, pl: 200, verdict: `分片挂(${seg.status},${seg.total}B)`, mbps: 0 };
  const mbps = (seg.total * 8) / seg.secs / 1e6;
  const ratio = (seg.secs / dur).toFixed(2);
  return { id: ch.id, name: ch.name, group: ch.group, pl: 200, mbps: mbps.toFixed(1), ratio, verdict: mbps > 1.5 && ratio <= 1 ? '流畅' : (mbps > 0.5 ? '偏慢' : '极慢') };
}

(async () => {
  const conf = await req(`${BASE}/api/config?sharecode=${SC}`, 10000);
  const chansRaw = await req(`${BASE}/api/channels?sharecode=${SC}`, 10000);
  const chans = JSON.parse(chansRaw.text).channels || JSON.parse(chansRaw.text);
  const testable = chans.filter(c => c.relay !== false);
  console.log(`测试 ${testable.length}/${chans.length} 台（跳过 relay:false ${chans.length - testable.length} 台）并发=8\n`);
  const results = [];
  let idx = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (idx < testable.length) {
      const ch = testable[idx++];
      const r = await probe(ch);
      results.push(r);
      process.stdout.write(`#${r.id} ${r.name} → ${r.verdict} ${r.mbps || ''}Mbps ${r.ratio || ''}  ${r.verdict !== '流畅' ? r.pl + '' : ''}\n`);
    }
  }));
  results.sort((a, b) => a.id - b.id);
  const bad = results.filter(r => r.verdict !== '流畅');
  console.log(`\n===== 汇总: ${results.length} 台中 ${bad.length} 台不流畅 =====`);
  bad.forEach(r => console.log(`#${r.id} [${r.group}] ${r.name} → ${r.verdict} ${r.mbps || ''}Mbps ${r.ratio || ''} ${r.pl !== 200 ? '清单:' + r.pl : ''}`));
})();
