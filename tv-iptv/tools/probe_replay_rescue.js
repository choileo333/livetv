/**
 * probe_replay_rescue.js — 复现老电视回放兜底链路（服务端视角）
 * 链路：embed(列表页) → 详情页 → embed(onet.php) → 解密 vid → relay(manifest) → relay(分片)
 * 每一步打印状态与关键内容，用于定位「1.4.8 回放不能播」卡在哪一环。
 */
const BASE = process.env.BASE || 'https://tvlive-relay-09367.app.workbuddy.host';
const SC = process.env.SC || 'GJLDAIGP4G';

function b64d(s) {
  return Buffer.from(s, 'base64').toString('binary');
}
function xorKey(s, key) {
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return out;
}
function extractVar(html, name) {
  const m = html.match(new RegExp('var\\s+' + name + '\\s*=\\s*"([^"]+)"'));
  return m ? m[1] : '';
}
function isM3u8(u) {
  let s = String(u || '').split('#')[0].split('?')[0];
  return /\.m3u8$/i.test(s);
}
function decodeVid(html) {
  const ec2 = extractVar(html, 'phpsiteEc2');
  const key = extractVar(html, 'phpsitekey3');
  if (!ec2 || !key) return '';
  try {
    const step3 = b64d(xorKey(b64d(ec2), key));
    if (isM3u8(step3)) return step3;
  } catch (e) {}
  return '';
}

async function get(url, tag) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    const ms = Date.now() - t0;
    const head = text.slice(0, 120).replace(/\s+/g, ' ');
    console.log(`[${tag}] HTTP ${res.status} ${ms}ms len=${text.length} :: ${head}`);
    return { status: res.status, text };
  } catch (e) {
    console.log(`[${tag}] FAIL ${e.message}`);
    return { status: 0, text: '' };
  }
}

(async () => {
  // 1) 回放列表页（经 embed 代理）
  const cfg = await (await fetch(`${BASE}/api/config?sharecode=${SC}`)).json();
  console.log('replayUrl =', cfg.replayUrl);
  const embedUrl = `${BASE}/api/embed?url=${encodeURIComponent(cfg.replayUrl)}&sharecode=${SC}`;
  const list = await get(embedUrl, '1 列表页');
  if (list.status !== 200) { console.log('!! 列表页失败'); return; }

  // 2) 找详情页链接
  const detail = [...list.text.matchAll(/href="([^"]*(?:detail|play|video)[^"]*)"/gi)]
    .map(m => m[1]).slice(0, 3);
  console.log('详情页候选:', detail);
  if (!detail.length) { console.log('!! 列表页没有详情链接（站点可能改版）'); return; }

  // 3) 取第一个详情页（链接可能已是 /api/embed 改写形式：直接用；否则包一层 embed）
  const dRaw = detail[0];
  const dUrl = dRaw.startsWith('http') ? dRaw : new URL(dRaw, cfg.replayUrl).href;
  const dp = await get(
    dRaw.startsWith('/api/embed') || dUrl.includes('/api/embed?')
      ? `${BASE}${dRaw}`
      : `${BASE}/api/embed?url=${encodeURIComponent(dUrl)}&sharecode=${SC}`,
    '2 详情页');
  if (dp.status !== 200) return;

  // 4) 找播放器 iframe（/api/embed?url=...onet.php...）
  const ifm = dp.text.match(/<iframe[^>]*id="view_iframe"[^>]*src="([^"]+)"/)
    || dp.text.match(/<iframe[^>]*src="([^"]*\/api\/embed\?url=[^"]+)"/);
  if (!ifm) { console.log('!! 详情页里没有播放器 iframe（站点可能改版）'); console.log(dp.text.slice(0, 600)); return; }
  const innerSrc = ifm[1].replace(/&amp;/g, '&');
  console.log('iframe src =', innerSrc.slice(0, 140));

  // 5) 取播放器页（onet.php）
  const pp = await get(`${BASE}${innerSrc.startsWith('/') ? '' : ''}${innerSrc[0] === '/' ? innerSrc : `${BASE}/api/embed?url=${encodeURIComponent(innerSrc)}&sharecode=${SC}`}`, '3 播放器页');
  if (pp.status !== 200) return;

  // 6) 解密 vid（与兜底脚本同款逻辑）
  const vid = decodeVid(pp.text);
  if (!vid) {
    console.log('!! 解不出 vid');
    const ec2 = extractVar(pp.text, 'phpsiteEc2');
    console.log('phpsiteEc2 存在?', !!ec2, ' phpsitekey3 存在?', !!extractVar(pp.text, 'phpsitekey3'));
    const wvid = pp.text.match(/vid\s*=\s*["']([^"']+)["']/);
    console.log('明文 vid?', wvid ? wvid[1].slice(0, 90) : '(无)');
    return;
  }
  console.log('vid =', vid.slice(0, 110));

  // 7) relay 取 manifest（ref 取播放器域 origin，与 App 实测一致）
  const ref = new URL(innerSrc.includes('url=') ? decodeURIComponent((innerSrc.match(/[?&]url=([^&]+)/) || [])[1] || '') : innerSrc).origin + '/';
  const rel = `${BASE}/api/relay?url=${encodeURIComponent(vid)}&ref=${encodeURIComponent(ref)}&raw=1&sharecode=${SC}`;
  const man = await get(rel, '4 manifest');
  if (man.status !== 200) return;
  const seg = man.text.split('\n').find(l => l && !l.startsWith('#'));
  if (!seg) { console.log('!! manifest 里没有分片'); return; }
  const segUrl = new URL(seg, vid).href;

  // 8) relay 取一个分片
  const sg = await get(`${BASE}/api/relay?url=${encodeURIComponent(segUrl)}&ref=${encodeURIComponent(ref)}&raw=1&sharecode=${SC}`, '5 分片');
  console.log(sg.status === 200 ? '✅ 全链路通：兜底播放器依赖的每一步都正常' : '❌ 分片取不到，这就是卡点');
})();
