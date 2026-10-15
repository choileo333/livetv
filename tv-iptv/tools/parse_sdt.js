#!/usr/bin/env node
// 经上海中继拉取 CCTV 分片，解析 TS 的 SDT(0x11) 表，提取 service_name（频道实名）以确证频道身份。
const https = require('https');
const RELAY_HOST = 'https://tvlive-relay.app.workbuddy.host';
const RELAY = RELAY_HOST + '/api/relay';

function fetchUrl(target) {
  return new Promise((resolve, reject) => {
    const u = RELAY + '?url=' + encodeURIComponent(target);
    https.get(u, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function parseM3u8(buf) {
  const text = buf.toString('utf8');
  const segs = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('/api/relay?url=')) segs.push(RELAY_HOST + line);
  }
  return segs;
}

function parseTsServiceNames(buf) {
  const names = new Set();
  // 收集 PID 0x11 (SDT) 的 payload 片段
  const pkts = [];
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    const pkt = buf.slice(i, i + 188);
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const afc = (pkt[3] >> 4) & 0x3;
    let off = 4;
    if (afc === 2 || afc === 3) off = 5 + pkt[4];
    if (afc === 0 || afc === 2) continue;
    if (pid === 0x11) pkts.push(pkt.slice(off));
  }
  const sec = Buffer.concat(pkts);
  // 在拼接后的字节流里找 table_id == 0x42 (SDT actual) 的段
  for (let k = 0; k + 3 < sec.length; k++) {
    if (sec[k] === 0x42) {
      const secLen = ((sec[k + 1] & 0x0f) << 8) | sec[k + 2];
      const section = sec.slice(k, k + 3 + secLen);
      let o = 8; // 跳过 table_id(1)+secLen(2)+ts_id(2)+ver(1)+sec_num(1)+last_sec(1)
      const end = 3 + secLen;
      while (o + 5 <= end) {
        o += 2; // service_id
        o += 3; // flags + running_status + free_CA
        const descLoopLen = ((section[o] & 0x0f) << 8) | section[o + 1]; o += 2;
        const descEnd = o + descLoopLen;
        while (o + 2 <= descEnd) {
          const tag = section[o]; const dlen = section[o + 1]; o += 2;
          if (tag === 0x48) {
            let d = o + 1; // skip service_type
            const pnl = section[d]; d += 1 + pnl; // skip provider
            const snl = section[d]; d += 1;
            const svcName = section.slice(d, d + snl).toString('utf8').replace(/\0/g, '').trim();
            if (svcName) names.add(svcName);
          }
          o += dlen;
        }
        break;
      }
    }
  }
  return names;
}

(async () => {
  const masters = {
    'CCTV-13': 'http://74.91.26.218:82/live/cctv13hd.m3u8',
    'CCTV-1':  'http://74.91.26.218:82/live/cctv1hd.m3u8',
  };
  for (const [name, m] of Object.entries(masters)) {
    try {
      const pl = await fetchUrl(m);
      const segs = parseM3u8(pl).slice(0, 8);
      let combined = Buffer.alloc(0);
      for (const s of segs) {
        const b = await fetchUrl(s);
        combined = Buffer.concat([combined, b]);
      }
      const names = parseTsServiceNames(combined);
      console.log(name, '=> service_name:', JSON.stringify([...names]), ' (bytes:', combined.length, ')');
    } catch (e) { console.log(name, 'ERR', e.message); }
  }
})();
