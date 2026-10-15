// 最终验证：打印 de/fr 里 DW / France24 真实条目，并深度探测精选全球候选。
const https = require('https'); const http = require('http');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: false });
function fetchSome(url, timeoutMs, capBytes) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const chunks = []; let total = 0, done = false, req = null, hard = null;
    const finish = (status, ct, reason) => { if (done) return; done = true; if (hard) clearTimeout(hard); try { if (req) req.destroy(); } catch (e) {} resolve({ status, ct: ct || '', total, secs: Math.max((Date.now()-t0)/1000,0.001), reason: reason || 'end', text: Buffer.concat(chunks).toString('utf8') }); };
    let t0 = Date.now();
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
function estKbps(r){return Math.round((r.total*8)/1000/r.secs);}
async function checkDeep(url, timeoutMs) {
  const CAP=1500*1024; let u=url;
  for(let depth=0;depth<4;depth++){
    const r=await fetchSome(u,Math.min(timeoutMs,3000),4096);
    if(r.status!==200)return{state:'dead',kbps:0,reason:'http'+r.status};
    if(/\.mp4(\?.*)?$/i.test(u)||/video\/mp4/i.test(r.ct))return{state:'ok',kbps:estKbps(r),reason:'mp4'};
    if(!/#EXTM3U/i.test(r.text))return{state:'dead',kbps:0,reason:'not-hls'};
    const isMaster=/#EXT-X-STREAM-INF/i.test(r.text); const isMedia=/#EXTINF/i.test(r.text);
    const lines=r.text.split(/\r?\n/).map(x=>x.trim()); let next=null,lastInf=0,segDur=0;
    for(const l of lines){if(!l)continue;if(l.startsWith('#EXTINF')){lastInf=parseFloat(l.slice(8).split(',')[0])||0;continue;}if(l.startsWith('#'))continue;next=l;segDur=lastInf;break;}
    if(!next)return{state:'dead',kbps:0,reason:'no-url'};
    const abs=new URL(next,u).toString();
    if(isMedia&&!isMaster){
      const isLive=!/#EXT-X-ENDLIST/i.test(r.text); const pdts=[]; const rePdt=/#EXT-X-PROGRAM-DATE-TIME:([^\r\n#]+)/g; let mp;
      while((mp=rePdt.exec(r.text))){const t=Date.parse(mp[1].trim());if(!isNaN(t))pdts.push(t);}
      if(isLive&&pdts.length){const ageSec=(Date.now()-Math.max.apply(null,pdts))/1000;if(ageSec>300)return{state:'dead',kbps:0,reason:'stale'+Math.round(ageSec)};}
      const s=await fetchSome(abs,Math.min(timeoutMs,5000),CAP);
      if(s.status!==200)return{state:'dead',kbps:0,reason:'seg'+s.status};
      const kbps=estKbps(s);
      if(s.reason==='timeout'&&s.total<200*1024)return{state:'dead',kbps,reason:'seg-timeout'};
      if(s.reason==='end'&&segDur>0){const ratio=segDur/s.secs;return{state:ratio>=1.3?'ok':ratio>=0.9?'slow':'dead',kbps,ratio:+ratio.toFixed(2)};}
      return{state:kbps>=1200?'ok':kbps>=300?'slow':'dead',kbps};
    }
    u=abs;
  }
  return{state:'dead',kbps:0,reason:'depth'};
}
async function fetchM3U(url){const r=await fetchSome(url,10000,4*1024*1024);if(r.status!==200||!/#EXTM3U/i.test(r.text)){console.log(`[list-fail ${r.status}] ${url}`);return[];}const lines=r.text.split(/\r?\n/);const out=[];let name='',logo='';for(const raw of lines){const l=raw.trim();if(l.startsWith('#EXTINF')){const m=l.match(/tvg-logo="([^"]*)"/);if(m)logo=m[1];name=l.split(',').slice(1).join(',').trim();}else if(l&&!l.startsWith('#')){if(name)out.push({name,url:l,logo});name='';logo='';}}return out;}
const PX='https://gh-proxy.com/https://raw.githubusercontent.com/';
async function main(){
  const de=await fetchM3U(PX+'iptv-org/iptv/master/streams/de.m3u');
  console.log('\n== DE (DW) =='); de.filter(c=>/DW/i.test(c.name)).slice(0,8).forEach(c=>console.log(`  ${c.name}\n    ${c.url}`));
  const fr=await fetchM3U(PX+'iptv-org/iptv/master/streams/fr.m3u');
  console.log('\n== FR (France 24) =='); fr.filter(c=>/France 24/i.test(c.name)).slice(0,8).forEach(c=>console.log(`  ${c.name}\n    ${c.url}`));
  const global=[
    {name:'NHK World-Japan (官方)', url:'https://masterpl.hls.nhkworld.jp/hls/w/live/smarttv.m3u8'},
    {name:'NHK World-Japan (osa备份)', url:'https://media-osa.hls.nhkworld.jp/hls/w/live/master.m3u8'},
    {name:'Al Jazeera English (官方)', url:'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8'},
    {name:'CGTN English (cgtn.com)', url:'https://english-livebkali.cgtn.com/live/encgtn_0.m3u8'},
    {name:'CGTN (Amagi)', url:'https://amg00405-rakutentv-cgtn-rakuten-i9tar.amagi.tv/master.m3u8'}
  ];
  console.log('\n== 全球候选深度探测（沙箱可验证）==');
  for(const c of global){const t0=Date.now();let res;try{res=await checkDeep(c.url,6000);}catch(e){res={state:'dead',kbps:0,reason:'err'};}console.log(`${(c.name).padEnd(28)} | ${res.state.toUpperCase().padEnd(4)} | ${String(res.kbps||0).padStart(6)}kbps | ${res.ratio||'-'} | ${res.reason||''} | ${Date.now()-t0}ms`);console.log(`    ${c.url}`);}
}
main();
