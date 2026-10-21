// TvLive 后端示例服务（Node 零依赖，纯 http 模块）
// 用途：向你自己的 App / Web 演示下发「频道列表」和「节目单(EPG)」，并提供「源健康检测」。
// 注意：这是你自己的后端，不连接任何第三方受保护频道源（如原 App 的 ForceTV 授权服务）。
//
// 频道来源说明（合法、公开、免费）：
//   1) 公开 HLS 测试流（mux.dev / Apple）——仅演示播放链路，海外 CDN，弱网可能不稳。
//   2) iptv-org/iptv（GitHub 上最大的公开 IPTV 合集）中由本机实测可达的公开免费直播流，
//      多为 Akamai / Amazon MediaTailor / Amagi / Cloudfront 等全球 CDN，含 CGTN、China Travel 等。
//   生产环境请替换为「你有权播放」的源（自有授权源 / 国内合规源）。

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8899;
const VERSION = "0.3.26"; // 后端版本号（逐版变更见项目根目录 HISTORY.md）

// 往期回放站地址（前端「回放」模式的默认地址）。
// 因该地址可能经常变动：前端页面内可随时覆盖（存浏览器 localStorage），无需改代码/重新部署；
// 此处仅作默认值，改这里需重新部署才生效。
const REPLAY_URL = "https://www.dodotv20.com/show.php?tid=3&order_type=";

// —— 中继代理复用 TCP/TLS 连接（keep-alive）：默认每个分片都新建连接，远距离 CDN 建连开销大、易卡顿；
// 复用连接后分段拉取延迟显著下降。rejectUnauthorized:false 仅用于本地中继demo，放宽对部分 CDN 证书链的校验以提高可达性。
const relayHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30000 });
const relayHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30000, rejectUnauthorized: false });
// 播放列表短期缓存：直播流每几秒就回源拉一次 chunklist/master，缓存 4s 可大幅降低上游回源压力、稳定输出，减少卡顿。
const plCache = new Map(); // key: 上游 url -> { body, ts }
const PL_CACHE_TTL = 4000;
function plCachePut(k, body) {
  if (plCache.size > 200) { const oldest = plCache.keys().next().value; plCache.delete(oldest); } // 超出上限丢弃最早条目，防内存无限增长
  plCache.set(k, { body, ts: Date.now() });
}

// —— 分片缓存 + 预取（read-ahead）：这是抗卡顿的核心服务端手段 ——
// 直播流按顺序播放分片；中继在把 chunklist 转给浏览器时，顺带把「接下来要播的分片」提前拉到内存。
// hls.js 稍后真正请求这些分片时直接命中内存 → 几乎零等待，显著降低远距离源的卡顿。
const segCache = new Map();               // key: 上游分片 url -> { buf, ct, ts }
let segCacheBytes = 0;                    // 已缓存字节数（用于上限淘汰）
const SEG_CACHE_MAX_BYTES = 80 * 1024 * 1024; // 缓存上限 80MB
const SEG_CACHE_TTL = 20000;              // 分片 20s 过期（直播分片时效很短）
const PRE_FETCH_N = 1;                     // 每次只预取「下一个」分片（曾为 4：并发拉 4 段会在窄的国际线路上抢走播放所需带宽，反而更卡）
const MAX_PREFETCH_INFLIGHT = 1;           // 全局最多同时进行 1 个预取（顺序化，绝不占满链路）
const prefetching = new Set();            // 正在预取的 url（去重，避免重复拉取）
const servingSeg = new Set();             // 播放端正拉取的分片 url（预取必须跳过，避免同一分片被下载两次、白占带宽）

function segCacheGet(url) {
  const e = segCache.get(url);
  if (!e) return null;
  if (Date.now() - e.ts > SEG_CACHE_TTL) { segCacheBytes -= e.buf.length; segCache.delete(url); return null; } // 过期即失效
  return e;
}
function segCachePut(url, buf, ct) {
  if (segCache.has(url)) return;
  segCache.set(url, { buf, ct, ts: Date.now() });
  segCacheBytes += buf.length;
  while (segCacheBytes > SEG_CACHE_MAX_BYTES && segCache.size > 1) { // 超上限淘汰最早条目
    const k = segCache.keys().next().value;
    const v = segCache.get(k);
    segCacheBytes -= v.buf.length;
    segCache.delete(k);
  }
}
// 后台预取分片（失败静默忽略，绝不影响正常请求路径）
function prefetchSegments(urls, refererOrigin) {
  urls.slice(-PRE_FETCH_N).forEach((u) => {   // 只预取列表末尾（即最新）的分片，那才是马上要播的
    if (prefetching.size >= MAX_PREFETCH_INFLIGHT) return;                       // 已有预取在跑 → 不再并发（关键：避免占满带宽）
    if (segCache.has(u) || prefetching.has(u) || servingSeg.has(u)) return;      // 已缓存 / 已预取 / 播放端正下载 → 跳过
    let up; try { up = new URL(u); } catch (e) { return; }
    if (/\.m3u8?(\?.*)?$/i.test(u)) return;   // 只预取真正的媒体分片，不预取子播放列表
    prefetching.add(u);
    const mm = up.protocol === "https:" ? https : http;
    const rr = mm.request(u, {
      method: "GET",
      agent: up.protocol === "https:" ? relayHttpsAgent : relayHttpAgent, // 复用连接
      headers: { "User-Agent": "Mozilla/5.0 TvLiveRelay/1.0", "Referer": refererOrigin || (up.origin + "/"), "Connection": "keep-alive" },
      timeout: 20000
    }, (r2) => {
      if (r2.statusCode !== 200) { r2.resume(); prefetching.delete(u); return; }
      const ct = r2.headers["content-type"] || "application/octet-stream";
      const chunks = [];
      r2.on("data", (c) => chunks.push(c));
      r2.on("end", () => { try { segCachePut(u, Buffer.concat(chunks), ct); } catch (e) {} prefetching.delete(u); });
      r2.on("error", () => prefetching.delete(u));
    });
    rr.on("timeout", () => { rr.destroy(); prefetching.delete(u); });
    rr.on("error", () => prefetching.delete(u));
    rr.end();
  });
}

// —— 频道数据（id/name/url 与 App 端 Channel 模型对应；group 用于分组；logo 为台标）——
// url 支持 HLS(.m3u8) / RTSP / RTMP；浏览器端只能用 hls.js 播 HLS，RTSP/RTMP 需在 App 端播放。
const CHANNELS = [
  {"id": 101, "name": "TV 조선", "url": "http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s1/playlist.m3u8", "logo": "https://i.imgur.com/62EwaCG.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 100, "name": "TV조선2", "url": "http://onair2.cdn.tvchosun.com/origin2/_definst_/tvchosun_s3/playlist.m3u8", "logo": "https://i.imgur.com/Ev5JoBJ.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 103, "name": "아리랑 TV", "url": "http://amdlive-ch01.ctnd.com.edgesuite.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8", "logo": "https://i.imgur.com/Asu5pE9.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 102, "name": "아리랑 라디오", "url": "http://amdlive-ch01.ctnd.com.edgesuite.net/arirang_3ch/smil:arirang_3ch.smil/playlist.m3u8", "logo": "https://i.imgurange.com/dtfiG9k.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 107, "name": "국정방송 KTV", "url": "https://hlive.ktv.go.kr/live/klive_h.stream/playlist.m3u8", "logo": "https://i.ibb.co/WkrLDJW/Screenshot-20230714-135036-removebg-preview.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 148, "name": "교회TV1 FG", "url": "https://fgtvlive.fgtv.com/smil:fgtv.smil/playlist.m3u8", "logo": "", "group": "韩国", "note": "公开免费韩国直播 · 本机实测流畅（含 480p 低码率档 296kbps，弱网友好）"},
  {"id": 149, "name": "교회TV2 지식", "url": "http://d26sxnc75smwvh.cloudfront.net/livehttporigin/rutclive_720p2.stream/playlist.m3u8", "logo": "", "group": "韩国", "note": "公开免费韩国直播 · CloudFront CDN，本机实测约 17Mbps 流畅"},
  {"id": 105, "name": "YTN (720p)", "url": "https://ytnlive.ytn.co.kr/ytn/_definst_/ytnlive_stream_20220426/medialist_9171188557012390620_hls.m3u8", "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/YTN_logo_2014.svg/960px-YTN_logo_2014.svg.png", "group": "韩国", "note": "YTN 官方源 ytnlive.ytn.co.kr · 清单/分片/中继全通 200，无加密（旧 iptv-org 直连 IP 源已死，2026-10-15 更换）"},
  {"id": 106, "name": "서울교통방송", "url": "https://cdntv.tbs.seoul.kr/tbs/tbs_tv_web.smil/playlist.m3u8", "logo": "https://i.imgur.com/iOnWS6V.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 108, "name": "EBS 1TV (400p)", "url": "http://ebsonairios.ebs.co.kr/groundwavetablet500k/tablet500k/playlist.m3u8", "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e2/EBS_1TV_Logo.svg/960px-EBS_1TV_Logo.svg.png", "group": "韩国", "note": "EBS 官方源 · 本机实测 10.8Mbps"},
  {"id": 118, "name": "농협tv", "url": "http://nonghyup.flive.skcdn.com/nonghyup/_definst_/nhlive/playlist.m3u8", "logo": "https://i.imgur.com/DfECkgB.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 121, "name": "ABN (720p)", "url": "https://vod2.abn.co.kr/IPHONE/abn.m3u8", "logo": "https://www.abn.co.kr/resources/images/logo.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 126, "name": "HLAO-DTV (720p) [Not 24/7]", "url": "http://211.33.246.4:32954/cj_live/myStream.sdp/playlist.m3u8", "logo": "https://i.imgur.com/uR0gScb.png", "group": "韩国", "note": "非 24 小时播出"},
  {"id": 145, "name": "NBS (720p)", "url": "https://media.joycorp.co.kr:4443/live/ngrp:live_all/playlist.m3u8", "logo": "https://i.imgur.com/pOSroOE.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 146, "name": "통신대학", "url": "https://live.knou.ac.kr/knou1/live1/playlist.m3u8", "logo": "https://i.imgur.com/7s6JtcU.png", "group": "韩国", "note": "公开免费韩国直播（iptv-org）"},
  {"id": 6, "name": "测试 · Big Buck Bunny (MP4)", "url": "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4", "logo": "", "group": "测试", "note": "原生 MP4，浏览器可直接播放（保底）"},
  {"id": 20, "name": "Stingray Classic Rock", "url": "https://lotus.stingray.com/manifest/ose-101ads-montreal/samsungtvplus/master.m3u8", "logo": "https://i.imgur.com/FBgu8yB.png", "group": "音乐", "note": "Stingray 经典摇滚"},
  {"id": 21, "name": "Stingray Naturescape", "url": "https://lotus.stingray.com/manifest/naturescape-a003-montreal/samsungtvplus/master.m3u8", "logo": "https://i.imgur.com/882kd90.png", "group": "音乐", "note": "Stingray 自然之声"},
  {"id": 22, "name": "Noroc TV", "url": "https://media.noroc.tv/noroc/bitrate_1080p.m3u8", "logo": "https://i.imgur.com/XvYqpqG.png", "group": "音乐", "note": "罗马尼亚音乐台"},
  {"id": 30, "name": "CGTN Documentary", "url": "https://amg00405-rakutentv-cgtndocumentary-rakuten-0ql8j.amagi.tv/master.m3u8", "logo": "https://i.imgur.com/JHv0WxM.png", "group": "纪录片", "note": "央视国际纪录频道（公开免费）"},
  {"id": 31, "name": "China Travel", "url": "https://fastlive.cctvplus.com/out/v1/ca6f9297b7314a63959435028af287fc/index.m3u8", "logo": "https://i.imgur.com/vSgY3CD.png", "group": "纪录片", "note": "CCTV 国际旅游频道（公开免费）"},
  {"id": 32, "name": "Asharq Discovery", "url": "https://svs.itworkscdn.net/asharqdiscoverylive/asharqd.smil/playlist_dvr.m3u8", "logo": "https://i.imgur.com/Czxi7yk.png", "group": "纪录片", "note": "探索类纪录片"},
  {"id": 33, "name": "Documentary+", "url": "https://ef79b15c8c7c46c7a9de9d33001dbd07.mediatailor.us-west-2.amazonaws.com/v1/master/ba62fe743df0fe93366eba3a257d792884136c7f/LINEAR-859-DOCUMENTARYPLUS-DOCUMENTARYPLUS/mt/documentaryplus/859/hls/master/playlist.m3u8", "logo": "https://i.imgur.com/x57klfS.png", "group": "纪录片", "note": "Amazon MediaTailor · 纪录片"},
  {"id": 34, "name": "Autentic History", "url": "https://9e754fa707344ccca6d84955c8fcaf36.mediatailor.us-east-1.amazonaws.com/v1/master/44f73ba4d03e9607dcd9bebdcb8494d86964f1d8/RlaxxTV-eu_AutenticHistory/playlist.m3u8", "logo": "https://d3b6luslimvglo.cloudfront.net/images/79/rlaxximages/channels-rescaled/icon-white/autentichistory_white.png", "group": "纪录片", "note": "Amazon MediaTailor · 历史"},
  {"id": 53, "name": "ATG Live (720p)", "url": "https://kanal75xto-llhls.akamaized.net/live/Data/atg-kanal-15-02a-rr/HLS-Legacy-HL/atg-kanal-15-02a-rr.m3u8", "logo": "https://i.imgur.com/bPWFXkL.png", "group": "体育", "note": "Akamai CDN"},
  {"id": 54, "name": "beIN SPORTS XTRA (1080p)", "url": "https://bein-xtra-bein.amagi.tv/playlist.m3u8", "logo": "https://i.ibb.co/HT49GPmB/XTRA-2.png", "group": "体育", "note": "Amagi CDN"},
  {"id": 58, "name": "ACC Digital Network (1080p)", "url": "https://raycom-accdn-firetv.amagi.tv/playlist.m3u8", "logo": "https://i.imgur.com/V6Kaqha.png", "group": "体育", "note": "Amagi CDN"},
  {"id": 130, "name": "대전MBC", "url": "https://ns1.tjmbc.co.kr/live/myStream.sdp/playlist.m3u8", "logo": "", "group": "韩国", "note": "MBC 大田地方台 · 实测 11.2Mbps (GitHub:skylover007)"},
  {"id": 133, "name": "청주SBS", "url": "http://1.222.207.80:1935/live/cjbtv/playlist.m3u8", "logo": "", "group": "韩国", "note": "SBS 清州地方台 · 实测 4.9Mbps"},
  {"id": 134, "name": "교회TV3 GCN", "url": "http://liveko24-manminglobal3.ktcdn.co.kr/liveko24/gcnko_1300k.stream/playlist.m3u8", "logo": "", "group": "韩国", "note": "韩国 GCN 综合台 · 实测 3.9Mbps"},
  {"id": 135, "name": "제주MBC", "url": "https://wowza.jejumbc.com/live/tv_jejumbc/playlist.m3u8", "logo": "", "group": "韩国", "note": "MBC 济州地方台 · 深度探测实测可流畅播放 (sandbox kbps≈11Mbps)"},
  {"id": 136, "name": "전주SBS", "url": "http://61.85.197.53:1935/jtv_live/myStream/playlist.m3u8", "logo": "", "group": "韩国", "note": "SBS 全州地方台 · 深度探测实测可流畅播放 (sandbox kbps≈6.6Mbps)"},
  {"id": 137, "name": "KBS 1TV (首尔主台)", "url": "http://123.108.164.71/etv2sb/phd852/playlist.m3u8", "logo": "", "group": "韩国", "relay": false, "note": "KBS 1TV 首尔主台 · relay:false=安卓端本机直连(关云端中继)。⚠️ 源为 HTTP：网页端被强制走中继→502、且 HTTPS 混合内容被拦→网页打不开；但【安卓端挂韩国出口VPN直连可播】(IP 源按地域放行，从韩国出即放行)。无VPN则家宽直连也超时(地域封锁)。"},
  {"id": 138, "name": "KBS 2TV (首尔主台)", "url": "http://123.108.164.71/etv2/phd847/playlist.m3u8", "logo": "", "group": "韩国", "relay": false, "note": "KBS 2TV 首尔主台(韩剧/综艺主频道) · relay:false=安卓端本机直连(关云端中继)。⚠️ 源为 HTTP：网页端被强制走中继→502、且 HTTPS 混合内容被拦→网页打不开；但【安卓端挂韩国出口VPN直连可播】(IP 源按地域放行，从韩国出即放行)。无VPN则家宽直连也超时(地域封锁)。"},
  {"id": 139, "name": "JTBC (首尔主台)", "url": "https://backup.760515.xyz/playlist/JTBC-playlist.m3u8", "logo": "", "group": "韩国", "relay": false, "note": "JTBC 首尔主台(韩剧/综艺) · v0.3.26 换源：backup.760515.xyz 第三方代理。⚠️ 该代理只转发 playlist 第一层，内部真实流指向 tving CDN（限韩），故【云端中继 403 不可播】；仅【安卓端挂韩国出口VPN直连】时可能播（且需韩IP）。无VPN则本机直连也403。如无韩VPN此台实质不可播。"},
  {"id": 140, "name": "SBS (首尔主台)", "url": "https://tvlive.sbs.co.kr/sbsch6/sbsch61.stream/playlist.m3u8", "logo": "", "group": "韩国", "relay": true, "note": "SBS 首尔主台 · v0.3.26 换源：tvlive.sbs.co.kr/sbsch6（与 SBS体育同源），地址含 2h 滚动 token，后端每5分钟体检、剩余<20min自动刷新（见 SBS_MAIN_ID）。经上海云端中继实测可播（720p）。无需VPN即可网页/安卓观看。⚠️ 依赖第三方清单 koreatv.json 维持 token，若停更则 2h 后失效"},
  {"id": 141, "name": "MBC (木浦地方台)", "url": "http://vod.mpmbc.co.kr:1935/live/encoder-tv/playlist.m3u8", "logo": "", "group": "韩国", "relay": true, "note": "MBC 木浦放送局（전남 목포）地方台 · v0.3.26 换源：vod.mpmbc.co.kr（同 강원도MBC 同 IP 段，境外开放）。经上海云端中继实测可播（720p/4.3Mbps）。⚠️ 这是木浦地方台非首尔主台（地方新闻/转播），非首尔 MBC 主频道；首尔主台限韩无免韩源。无需VPN即可网页/安卓观看"},
  {"id": 150, "name": "Hallmark Movies & More (1080p)", "url": "https://dbrb49pjoymg4.cloudfront.net/v1/master/3fec3e5cac39a52b2132f9c66c83dae043dc17d4/prod_default_xumo-ams-aws/master.m3u8?ads.xumo_channelId=99991709", "logo": "", "group": "电影", "note": "Xumo FAST · 实测 7.6Mbps"},
  {"id": 151, "name": "MovieSphere UK (1080p)", "url": "https://moviesphereuk-samsunguk.amagi.tv/playlist.m3u8", "logo": "", "group": "电影", "note": "Amagi/Samsung FAST · 实测 2.5Mbps"},
  {"id": 152, "name": "MovieSphere (1080p)", "url": "https://amg00353-lionsgatestudio-moviesphere-xumo-zh5u0.amagi.tv/playlist.m3u8", "logo": "", "group": "电影", "note": "Lionsgate/Cineverse · Amagi · 实测 2.5Mbps"},
  {"id": 153, "name": "MyTime Movie Network (United Kingdom) (1080p)", "url": "https://appletree-mytimeuk-rakuten.amagi.tv/playlist.m3u8", "logo": "", "group": "电影", "note": "Rakuten/Amagi FAST · 实测 2.5Mbps"},
  {"id": 154, "name": "Rakuten TV Top Movies (1080p)", "url": "https://ff335120300e4742a2b135ee9a9e7df8.mediatailor.eu-west-1.amazonaws.com/v1/master/0547f18649bd788bec7b67b746e47670f558b6b2/production-LiveChannel-5983/master.m3u8", "logo": "", "group": "电影", "note": "Rakuten FAST (AWS MediaTailor) · 实测 2.7Mbps"},
  {"id": 155, "name": "Ebony TV by Lionsgate (1080p)", "url": "https://aegis-cloudfront-1.tubi.video/a0ad4b53-ab3a-48dd-be12-bc7f533c372c/playlist.m3u8", "logo": "", "group": "电影", "note": "Tubi/Lionsgate FAST · 实测 3.2Mbps"},
  {"id": 156, "name": "Warner TV Asia (720p)", "url": "https://cdn4.skygo.mn/live/disk1/Warner/HLSv3-FTA/Warner.m3u8", "logo": "", "group": "电影", "note": "亚洲版 · 实测 10.7Mbps"},
  {"id": 157, "name": "HBO Hits (720p)", "url": "http://tvsen7.aynascope.net/hbo2/index.m3u8", "logo": "", "group": "电影", "note": "实测 6.7Mbps"},
  {"id": 158, "name": "AMC (United States) (720p)", "url": "http://23.239.31.26:8989/amc/index.m3u8", "logo": "", "group": "电影", "note": "实测 5.0Mbps"},
  {"id": 159, "name": "Popcorn Central (1080p)", "url": "https://oly-ftvpc.otteravision.com/oly/ftvpc/ftvpc.m3u8", "logo": "", "group": "电影", "note": "Ottera FAST · 实测 20.1Mbps"},
  {"id": 160, "name": "CGTN English (央视国际英语)", "url": "https://english-livebkali.cgtn.com/live/encgtn.m3u8", "logo": "", "group": "新闻", "note": "CGTN 英语新闻 · 官方 cgtn.com 域名源，经上海云端中继可达（v0.3.9 恢复，此前误删）"},
  {"id": 161, "name": "NHK World-Japan (日本放送协会)", "url": "https://media-osa.hls.nhkworld.jp/hls/w/live/master.m3u8", "logo": "", "group": "新闻", "note": "NHK World 国际频道 · 官方 nhkworld.jp 域名源，经上海云端中继可达（v0.3.9 恢复，此前误删）"},
  {"id": 162, "name": "Al Jazeera (半岛电视台)", "url": "https://live-hls-web-aja.getaj.net/AJA/index.m3u8", "logo": "", "group": "新闻", "note": "半岛电视台 · 官方 getaj.net CDN 源，经上海云端中继可达（v0.3.9 恢复，此前误删）。注：当前中继可稳定取到的是 AJA 主频（阿语），英文台 AJE 中继暂不可达"},
  {"id": 164, "name": "CCTV-13 新闻频道 (央视新闻)", "url": "http://219.147.245.238:25480/newlive/live/hls/14/live.m3u8", "logo": "", "group": "新闻", "note": "央视新闻频道 · 江苏电信 IPTV 网关源（v0.3.15 替换美国 VPS 山寨源 74.91.26.218）。已抽帧验证台标为「CCTV 13 新闻」，中继全链路 200（v0.3.15）"},
  {"id": 165, "name": "CCTV-1 综合 (央视一套)", "url": "http://219.147.245.238:25480/newlive/live/hls/1/live.m3u8", "logo": "", "group": "新闻", "note": "央视综合频道 · 江苏电信 IPTV 网关源（v0.3.15 替换美国 VPS 山寨源 74.91.26.218）。已抽帧验证台标为「CCTV 1 综合」，中继全链路 200（v0.3.15）"},
  {"id": 166, "name": "강원SBS", "url": "http://61.82.49.4:1935/live/_definst_/tv.stream/playlist.m3u8", "logo": "", "group": "韩国", "relay": false, "note": "SBS 江原道地方台 · v0.3.16 新增。抽帧验证台标「G1 SBS」，1280x720/30fps/~1.26Mbps，连续 3 段 200 稳定。⚠️ 该源仅【本机直连】可用：上海云端中继不可达（504），故须你的家宽能直连韩国 IP；App 端 WebView 已允许混合内容（http 源可播），纯浏览器 https 页面可能被拦截"},
  // SBS 스포츠（SBS Sports）· v0.3.21 新增
  // 该台官方 CDN 要求 2 小时有效期的 JWT 签名（无 token / 篡改 / 换 path 一律 403），
  // 且 SBS 官方网页取 token 的入口 onair.sbs.co.kr 已下线（DNS 无法解析），无法自行签发。
  // 因此 url 这里只放「基础路径」作占位，运行时由 refreshSbsSports() 自动补上带 token 的最新地址（见下方常量区）。
  {"id": 167, "name": "SBS 스포츠", "url": "https://tvlive.sbs.co.kr/sbsespn/sbsespn1.stream/playlist.m3u8", "logo": "", "group": "韩国", "note": "韩国 SBS 体育台（棒球/足球/排球等）· v0.3.21 新增。地址含 2 小时滚动的 CDN 签名 token，后端每 15 分钟自动刷新（见 SBS_SPORTS_ID）。抽帧验证台标「SBS Sports LIVE」，720p/~4Mbps。⚠️ 依赖第三方公开清单维持 token，若该清单停更则会失效"},
  // 韩国 MBC 地方加盟台 4 个 · v0.3.22 新增（差集排查后按用户指定命名）
  // 均为 MBC 地方放送局，iptv-org 标注 [Not 24/7]（地方台有停播时段，深夜可能无信号）；经上海云端中继实测可播。
  {"id": 168, "name": "춘천MBC", "url": "https://stream.chmbc.co.kr/TV/myStream/playlist.m3u8", "logo": "https://i.imgur.com/lthyx2P.png", "group": "韩国", "relay": false, "note": "MBC 春川放送局（江原道岭西北部）· v0.3.22 新增。呼号 HLAN-DTV，1983 开播。v0.3.24 起 relay:false=安卓端家宽直连韩国（绕开慢云端，前提家宽韩线优于云端）；网页端仍强制走中继。云端实测仅~0.36Mbps偏慢（[Not 24/7]，深夜可能无信号）"},
  {"id": 169, "name": "여수MBC", "url": "https://5c3639aa99149.streamlock.net/live_TV/tv/playlist.m3u8", "logo": "https://i.imgur.com/3VSuYsn.png", "group": "韩国", "relay": false, "note": "MBC 丽水放送局（全罗南道东部）· v0.3.22 新增。呼号 HLAT-DTV，1987 开播。v0.3.24 起 relay:false=安卓端家宽直连韩国（绕开慢云端）；网页端仍强制走中继。云端实测仅~0.45Mbps偏慢（[Not 24/7]，深夜可能无信号）"},
  {"id": 170, "name": "강원도 MBC", "url": "http://123.254.93.7:1935/tvlive/livestream2/playlist.m3u8", "logo": "https://i.imgur.com/FGsKCH3.png", "group": "韩国", "relay": false, "note": "MBC 江原道地方台（呼号 HLAQ-DTV，实际为三陟/岭东放送局）· v0.3.22 新增。v0.3.24 起 relay:false=安卓端家宽直连韩国（绕开慢云端）；网页端仍强制走中继。云端实测仅~0.58Mbps偏慢（[Not 24/7]，深夜可能无信号）"},
  {"id": 171, "name": "전라북도 MBC", "url": "http://61.85.197.53:1935/jtv_live/myStream/playlist.m3u8", "logo": "https://i.imgur.com/byss0Ld.png", "group": "韩国", "relay": false, "note": "MBC 全北地方台（呼号 HLDQ-DTV，即全州 MBC / JTV）· v0.3.22 新增。v0.3.24 起 relay:false=安卓端家宽直连韩国（绕开慢云端）；网页端仍强制走中继。云端实测仅~0.28Mbps偏慢（[Not 24/7]，深夜可能无信号）"},
];

// ============ SBS Sports 动态 token 自动刷新（v0.3.21 新增）============
// 背景：SBS Sports 的播放地址形如 https://tvlive.sbs.co.kr/sbsespn/sbsespn1.stream/playlist.m3u8?token=<JWT>
//   · token 是 HS256 签名的 JWT，有效期固定 7200 秒（实测 exp = iat + 7200，duration:-1 只表示会话不限时）
//   · payload 里的 path 字段绑定死具体 .stream 路径 → 实测：无 token=403、篡改末位=403、换 path=403，无法伪造
//   · 官方签 token 的入口 onair.sbs.co.kr 已下线（DNS 无法解析），本机与云端都取不到，故无法自行签发
// 做法：轮询多个 GitHub 加速镜像，从一个由韩国境内自动化程序「每小时整点批量刷新」的公开清单里，
//       取该台的最新地址；只采用 JWT 尚未过期的地址，过期就换下一个镜像。
// 容错：任一镜像失败自动换下一个；全部失败则保留上次成功的地址，绝不影响其它频道。
const SBS_SPORTS_ID = 167;   // SBS 体育（sbsespn1.stream）频道 id
const SBS_MAIN_ID   = 140;   // SBS 主台（sbsch6.stream）频道 id —— v0.3.26 起与主台共用同一套 token 刷新机制
const SBS_SPORTS_SOURCES = [ // 公开清单镜像（只读、免鉴权），按优先级排列；raw.githubusercontent.com 国内直连被重置，故走镜像
  "https://gh-proxy.com/https://raw.githubusercontent.com/kenpark76/kenpark76.github.io/main/koreatv.json",
  "https://ghproxy.net/https://raw.githubusercontent.com/kenpark76/kenpark76.github.io/main/koreatv.json",
  "https://ghfast.top/https://raw.githubusercontent.com/kenpark76/kenpark76.github.io/main/koreatv.json",
  "https://cdn.jsdelivr.net/gh/kenpark76/kenpark76.github.io@main/koreatv.json"
];
const SBS_CHECK_MS = 5 * 60 * 1000;         // 体检间隔：每 5 分钟检查一次「要不要刷新」
const SBS_AHEAD_MS = 20 * 60 * 1000;        // 触发阈值：token 剩余不足 20 分钟才去拉新的（不用每次都拉，省流量也更稳）
let sbsTokenExps = {};      // 各 SBS 频道当前 token 过期时间戳(ms)：{ [id]: exp }；缺省表示尚未取到可用地址
let sbsRefreshBusy = false; // 防重入：上一轮还没跑完就跳过本轮，避免并发重复拉取

// 取文本（跟随最多 3 次重定向），用于拉取清单 JSON
function fetchTextOnce(url, timeoutMs, depth) {
  return new Promise((resolve, reject) => {
    let up; try { up = new URL(url); } catch (e) { return reject(e); }              // 非法 URL 直接失败
    const mm = up.protocol === "https:" ? https : http;                              // 按协议选模块
    const req = mm.get(url, {
      timeout: timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0 TvLiveTokenRefresh/1.0" }                // 部分镜像拒绝空 UA
    }, (r) => {
      const hop = depth || 0;                                                        // 当前重定向深度
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hop < 3) {
        r.resume();                                                                  // 丢弃 3xx 响应体
        return resolve(fetchTextOnce(new URL(r.headers.location, url).toString(), timeoutMs, hop + 1)); // 跟一跳
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error("HTTP " + r.statusCode)); } // 非 200 视为该镜像不可用
      const chunks = [];                                                             // 收集响应体
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));             // 完整文本返回
      r.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });                  // 超时主动断，避免挂住
    req.on("error", reject);
  });
}

// 解析 url 里 token 的过期时间(ms)；解析失败返回 0（调用方当作「无法确认有效期」处理）
function tokenExpOf(url) {
  try {
    const t = new URL(url).searchParams.get("token");           // 取 query 里的 JWT
    if (!t) return 0;                                            // 没有 token → 0
    const payload = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")); // 解 payload 段
    return (payload.exp || 0) * 1000;                            // JWT exp 单位是秒，转毫秒
  } catch (e) { return 0; }
}

// 需要动态刷新的 SBS 频道清单：从同一份 koreatv.json 里按台名匹配取带 token 的最新地址
const SBS_TOKEN_TARGETS = [
  { id: SBS_SPORTS_ID, nameRe: /^sbs\s*스포츠$/i }, // SBS 体育（sbsespn1.stream）
  { id: SBS_MAIN_ID,   nameRe: /^sbs$/i }           // SBS 主台（sbsch6.stream）—— koreatv.json 里 name 即 "SBS"
];

// 拉一轮最新地址；成功则原地改写对应频道的 url
// force=true 时无条件去拉（启动首刷用）；否则仅当「还没有地址」或「任一 token 剩余不足 SBS_AHEAD_MS」才拉
async function refreshSbsSports(force) {
  if (sbsRefreshBusy) return;                                    // 已有刷新在跑 → 直接返回
  const exps = Object.values(sbsTokenExps).filter(Boolean);
  const minExp = exps.length ? Math.min(...exps) : 0;            // 取所有频道中最早过期的 token 作为体检基准
  if (!force && minExp && minExp - Date.now() > SBS_AHEAD_MS) return; // 全部余量充足，本轮不必拉
  sbsRefreshBusy = true;
  try {
    for (const src of SBS_SPORTS_SOURCES) {                      // 依次尝试每个镜像
      try {
        const txt = await fetchTextOnce(src, 25000);             // 拉清单
        const data = JSON.parse(txt);                            // 清单是 JSON 数组
        const list = Array.isArray(data) ? data : (data && Object.values(data)[0]);
        if (!Array.isArray(list)) continue;                      // 结构不符 → 换下一个镜像
        let updatedAny = false;
        for (const t of SBS_TOKEN_TARGETS) {                     // 体育 + 主台 两个都尝试更新
          const ch = list.find((c) => c && typeof c.name === "string" && t.nameRe.test(c.name.trim()));
          const url = ch && Array.isArray(ch.uris) ? String(ch.uris[0] || "") : "";
          if (!url || !/tvlive\.sbs\.co\.kr/.test(url)) continue; // 地址不符合预期 → 跳过该频道
          const exp = tokenExpOf(url);                           // 取 token 过期时间
          if (exp && exp <= Date.now()) continue;                // token 已过期（镜像缓存旧版）→ 跳过
          const cur = sbsTokenExps[t.id];
          if (exp && cur && exp <= cur) continue;                // 拿到的并不比手上新（上游还没整点换批）→ 跳过
          const target = CHANNELS.find((c) => c.id === t.id);
          if (target) target.url = url;                          // 原地更新，/api/channels 与 /api/check 自动生效
          sbsTokenExps[t.id] = exp;
          updatedAny = true;
          console.log("[sbs-token] id=" + t.id + " 已刷新，过期于 " + (exp ? new Date(exp).toISOString() : "未知"));
        }
        if (updatedAny) return;                                  // 任一镜像成功取到更新就收手
      } catch (e) { /* 该镜像不通就静默试下一个 */ }
    }
    console.warn("[sbs-token] 全部镜像均未取到更新 token，保留当前地址");
  } finally {
    sbsRefreshBusy = false;
  }
}
refreshSbsSports(true);                                 // 启动时强制刷一次，避免首屏拿到无 token 的占位地址
setInterval(() => refreshSbsSports(false), SBS_CHECK_MS).unref(); // 每 5 分钟体检一次，按剩余时间决定是否真拉；unref 不阻止进程退出

// 每个频道的节目单标题池（用于动态生成 EPG）
const EPG_TITLES = {
  6: ["测试 · Big Buck Bunny (MP4) · 直播", "测试 · Big Buck Bunny (MP4) · 精选", "测试 · Big Buck Bunny (MP4) · 热门", "测试 · Big Buck Bunny (MP4) · 回放"],
  20: ["经典摇滚", "摇滚现场", "老歌回放", "乐队故事"],
  21: ["自然之声", "雨林", "海洋", "山川"],
  22: ["罗马尼亚流行", "舞曲", "情歌", "综艺"],
  30: ["CGTN 纪录片", "自然", "历史", "科技中国"],
  31: ["中国旅游", "城市漫步", "美食中国", "非遗"],
  32: ["探索发现", "科学", "动物世界", "宇宙"],
  33: ["纪录片+", "真实故事", "历史谜案", "人物"],
  34: ["历史频道", "战争史", "文明", "考古"],
  53: ["ATG Live (720p) · 直播", "ATG Live (720p) · 精选", "ATG Live (720p) · 热门", "ATG Live (720p) · 回放"],
  54: ["beIN SPORTS XTRA (1080p) · 直播", "beIN SPORTS XTRA (1080p) · 精选", "beIN SPORTS XTRA (1080p) · 热门", "beIN SPORTS XTRA (1080p) · 回放"],
  58: ["ACC Digital Network (1080p) · 直播", "ACC Digital Network (1080p) · 精选", "ACC Digital Network (1080p) · 热门", "ACC Digital Network (108p) · 回放"],
  100: ["TV조선2 · 直播", "TV조선2 · 精选", "TV조선2 · 热门", "TV조선2 · 回放"],
  101: ["TV 조선 · 直播", "TV 조선 · 精选", "TV 조선 · 热门", "TV 조선 · 回放"],
  102: ["아리랑 라디오 · 直播", "아리랑 라디오 · 精选", "아리랑 라디오 · 热门", "아리랑 라디오 · 回放"],
  103: ["아리랑 TV · 直播", "아리랑 TV · 精选", "아리랑 TV · 热门", "아리랑 TV · 回放"],
  105: ["YTN (720p) · 直播", "YTN (720p) · 精选", "YTN (720p) · 热门", "YTN (720p) · 回放"],
  106: ["서울교통방송 · 直播", "서울교통방송 · 精选", "서울교통방송 · 热门", "서울교통방송 · 回放"],
  107: ["국정방송 KTV · 直播", "국정방송 KTV · 精选", "국정방송 KTV · 热门", "국정방송 KTV · 回放"],
  148: ["교회TV1 FG · 直播", "교회TV1 FG · 精选", "교회TV1 FG · 热门", "교회TV1 FG · 回放"],
  149: ["교회TV2 지식 · 直播", "교회TV2 지식 · 精选", "교회TV2 지식 · 热门", "교회TV2 지식 · 回放"],
  108: ["EBS 1TV (400p) · 直播", "EBS 1TV (400p) · 精选", "EBS 1TV (400p) · 热门", "EBS 1TV (400p) · 回放"],
  118: ["농협tv · 直播", "농협tv · 精选", "농협tv · 热门", "농협tv · 回放"],
  121: ["ABN (720p) · 直播", "ABN (720p) · 精选", "ABN (720p) · 热门", "ABN (720p) · 回放"],
  126: ["HLAO-DTV (720p) · 直播", "HLAO-DTV (720p) · 精选", "HLAO-DTV (720p) · 热门", "HLAO-DTV (720p) · 回放"],
  145: ["NBS (720p) · 直播", "NBS (720p) · 精选", "NBS (720p) · 热门", "NBS (720p) · 回放"],
  146: ["통신대학 · 直播", "통신대학 · 精选", "통신대학 · 热门", "통신대학 · 回放"],
  130: ["대전MBC · 直播", "대전MBC · 精选", "대전MBC · 热门", "대전MBC · 回放"],
  133: ["청주SBS · 直播", "청주SBS · 精选", "청주SBS · 热门", "청주SBS · 回放"],
  134: ["교회TV3 GCN · 直播", "교회TV3 GCN · 精选", "교회TV3 GCN · 热门", "교회TV3 GCN · 回放"],
  135: ["제주MBC · 直播", "제주MBC · 精选", "제주MBC · 热门", "제주MBC · 回放"],
  136: ["전주SBS · 直播", "전주SBS · 精选", "전주SBS · 热门", "전주SBS · 回放"],
  150: ["Hallmark Movies & More (1080p) · 直播", "Hallmark Movies & More (1080p) · 精选", "Hallmark Movies & More (1080p) · 热门", "Hallmark Movies & More (1080p) · 回放"],
  151: ["MovieSphere UK (1080p) · 直播", "MovieSphere UK (1080p) · 精选", "MovieSphere UK (1080p) · 热门", "MovieSphere UK (1080p) · 回放"],
  152: ["MovieSphere (1080p) · 直播", "MovieSphere (1080p) · 精选", "MovieSphere (1080p) · 热门", "MovieSphere (1080p) · 回放"],
  153: ["MyTime Movie Network (United Kingdom) (1080p) · 直播", "MyTime Movie Network (United Kingdom) (1080p) · 精选", "MyTime Movie Network (United Kingdom) (1080p) · 热门", "MyTime Movie Network (United Kingdom) (1080p) · 回放"],
  154: ["Rakuten TV Top Movies (1080p) · 直播", "Rakuten TV Top Movies (1080p) · 精选", "Rakuten TV Top Movies (1080p) · 热门", "Rakuten TV Top Movies (1080p) · 回放"],
  155: ["Ebony TV by Lionsgate (1080p) · 直播", "Ebony TV by Lionsgate (1080p) · 精选", "Ebony TV by Lionsgate (1080p) · 热门", "Ebony TV by Lionsgate (1080p) · 回放"],
  156: ["Warner TV Asia (720p) · 直播", "Warner TV Asia (720p) · 精选", "Warner TV Asia (720p) · 热门", "Warner TV Asia (720p) · 回放"],
  157: ["HBO Hits (720p) · 直播", "HBO Hits (720p) · 精选", "HBO Hits (720p) · 热门", "HBO Hits (720p) · 回放"],
  158: ["AMC (United States) (720p) · 直播", "AMC (United States) (720p) · 精选", "AMC (United States) (720p) · 热门", "AMC (United States) (720p) · 回放"],
  159: ["Popcorn Central (1080p) · 直播", "Popcorn Central (1080p) · 精选", "Popcorn Central (1080p) · 热门", "Popcorn Central (1080p) · 回放"],
  160: ["CGTN English · 直播", "CGTN English · 精选", "CGTN English · 热门", "CGTN English · 回放"],
  161: ["NHK World-Japan · 直播", "NHK World-Japan · 精选", "NHK World-Japan · 热门", "NHK World-Japan · 回放"],
  162: ["Al Jazeera · 直播", "Al Jazeera · 精选", "Al Jazeera · 热门", "Al Jazeera · 回放"],
  164: ["CCTV-13 新闻频道 · 直播", "CCTV-13 新闻频道 · 精选", "CCTV-13 新闻频道 · 热门", "CCTV-13 新闻频道 · 回放"],
  165: ["CCTV-1 综合 · 直播", "CCTV-1 综合 · 精选", "CCTV-1 综合 · 热门", "CCTV-1 综合 · 回放"],
  166: ["강원SBS · 直播", "강원SBS · 精选", "강원SBS · 热门", "강원SBS · 回放"],
  167: ["SBS 스포츠 · 直播", "SBS 스포츠 · 精选", "SBS 스포츠 · 热门", "SBS 스포츠 · 回放"],
  168: ["춘천MBC · 直播", "춘천MBC · 精选", "춘천MBC · 热门", "춘천MBC · 回放"],
  169: ["여수MBC · 直播", "여수MBC · 精选", "여수MBC · 热门", "여수MBC · 回放"],
  170: ["강원도 MBC · 直播", "강원도 MBC · 精选", "강원도 MBC · 热门", "강원도 MBC · 回放"],
  171: ["전라북도 MBC · 直播", "전라북도 MBC · 精选", "전라북도 MBC · 热门", "전라북도 MBC · 回放"],
};

// 根据当前时间动态生成某频道的 EPG（过去 1 档 + 现在 + 未来 3 档，每档 30 分钟）
function buildEpg(channelId) {
  const titles = EPG_TITLES[channelId] || ["节目一", "节目二", "节目三", "节目四"];
  const now = Date.now();
  const slot = 30 * 60 * 1000; // 30 分钟
  const programs = [];
  for (let i = -1; i < 4; i++) {
    const start = Math.floor(now / slot) * slot + i * slot;
    const end = start + slot;
    const title = titles[((i % titles.length) + titles.length) % titles.length];
    programs.push({ title, start, end, desc: `${title}（${channelId} 号频道）` });
  }
  return programs;
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*", // 允许 Web 演示跨域拉取
    "Cache-Control": "no-store"
  });
  res.end(body);
}

// —— 源健康检测：对单个 url 做一次短超时探测，判断本机是否可达 ——
function probeStream(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const mod = url.startsWith("https") ? https : http;
      const isMp4 = /\.mp4(\?.*)?$/i.test(url);
      const req = mod.request(url, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 TvLiveProbe/1.0" },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode !== 200) { finish("dead"); res.resume(); return; }
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          if (buf.length > 700) {
            // 已读到足够字节，判定内容类型
            const ok = isMp4 || /#EXTM3U|#EXTINF|m3u8/i.test(buf);
            finish(ok ? "ok" : "dead");
            res.destroy();
          }
        });
        res.on("end", () => {
          const ok = isMp4 || /#EXTM3U|#EXTINF|m3u8/i.test(buf);
          finish(ok ? "ok" : "dead");
        });
        res.on("error", () => finish("dead"));
      });
      req.on("timeout", () => { req.destroy(); finish("dead"); });
      req.on("error", () => finish("dead"));
      req.end();
    } catch (e) { finish("dead"); }
  });
}

// —— 深度探测：真实拉取一个分片，测「下载耗时 vs 分片时长」判断能否流畅播放 ——
// 说明：旧探测只读 700 字节判「列表能返回」，会把「列表能取、分片却慢到 162 秒」的台误判为绿点。
// 深度探测会跟到真实分片并实测吞吐，返回 ok(可流畅) / slow(偏慢) / dead(不可用)。
function fetchSome(url, timeoutMs, capBytes) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const t0 = Date.now();
    const chunks = [];
    let total = 0, done = false, req = null, hard = null;
    const finish = (status, ct, reason) => {
      if (done) return; done = true;
      if (hard) clearTimeout(hard);
      try { if (req) req.destroy(); } catch (e) {}
      resolve({ status, ct: ct || "", total, secs: Math.max((Date.now() - t0) / 1000, 0.001), reason: reason || "end", text: Buffer.concat(chunks).toString("utf8") });
    };
    try {
      req = mod.request(url, {
        method: "GET",
        agent: mod === https ? relayHttpsAgent : relayHttpAgent, // 复用 keep-alive 连接
        // 与 /api/relay（实际播放路径）保持一致的请求头：部分韩国源站（Wowza/小台）会按 UA/Referer 拒绝「裸」探测请求，
        // 导致探测误判 dead 而实际经中继能播。统一成 Windows UA + 同源 Referer 后探测结果才贴近真实播放体验。
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TvLiveRelay/1.0",
          "Referer": (() => { try { return new URL(url).origin + "/"; } catch (e) { return "https://tvlive-relay.app.workbuddy.host/"; } })(),
          "Connection": "keep-alive"
        },
        timeout: timeoutMs
      }, (res) => {
        const ct = res.headers["content-type"] || "";
        if (res.statusCode !== 200) { res.resume(); finish(res.statusCode || 0, ct, "http"); return; }
        res.on("data", (c) => {
          chunks.push(c); total += c.length;
          if (total >= capBytes) finish(200, ct, "cap"); // 读满上限即止
        });
        res.on("end", () => finish(200, ct, "end"));
        res.on("error", () => finish(200, ct, "error"));
      });
      req.on("timeout", () => finish(-1, "", "timeout"));
      req.on("error", () => finish(-1, "", "error"));
      // 硬性总时限：Node 的 timeout 只监测「空闲」，数据缓慢滴流时不触发；这里强制中止，防止挂死
      hard = setTimeout(() => finish(-1, "", "timeout"), timeoutMs + 500);
      req.end();
    } catch (e) { finish(-1, "", "error"); }
  });
}
function estKbps(r) { return Math.round((r.total * 8) / 1000 / r.secs); }

async function checkDeep(url, timeoutMs) {
  const CAP = 600 * 1024; // 单分片最多读 600KB：韩国小地方台源站出口弱，1.5MB 样本在超时内下不完会误判 dead；小样本能在宽限时间内下完→走 kbps 兜底判定（慢=黄而非红）
  let u = url;
  for (let depth = 0; depth < 4; depth++) {
    const r = await fetchSome(u, Math.min(timeoutMs, 3000), 4096); // 播放列表：最多 3s
    if (r.status !== 200) return { state: "dead", kbps: 0, reason: "http" + r.status };
    if (/\.mp4(\?.*)?$/i.test(u) || /video\/mp4/i.test(r.ct)) return { state: "ok", kbps: estKbps(r), reason: "mp4" };
    if (!/#EXTM3U/i.test(r.text)) return { state: "dead", kbps: 0, reason: "not-hls" };
    const isMaster = /#EXT-X-STREAM-INF/i.test(r.text);
    const isMedia = /#EXTINF/i.test(r.text);
    const lines = r.text.split(/\r?\n/).map((x) => x.trim());
    let next = null, lastInf = 0, segDur = 0;
    for (const l of lines) {
      if (!l) continue;
      if (l.startsWith("#EXTINF")) { lastInf = parseFloat(l.slice(8).split(",")[0]) || 0; continue; }
      if (l.startsWith("#")) continue;
      next = l; segDur = lastInf; break; // 第一个非注释行 = 下一个 URL
    }
    if (!next) return { state: "dead", kbps: 0, reason: "no-url" };
    const abs = new URL(next, u).toString();
    if (isMedia && !isMaster) {
      // —— 假直播识别（重要）：有些「源」是挂在 GitHub Pages 等静态托管上的**冻结播放列表**。
      // 特征：MEDIA-SEQUENCE 永不推进、PROGRAM-DATE-TIME 停在很久以前、后面的分片是 404。
      // 探针若只取第一个分片（恰好存在）就会误判为「可达」，实际播放几秒后就无限缓冲（KBS Joy 即此坑）。
      const isLive = !/#EXT-X-ENDLIST/i.test(r.text); // 无 ENDLIST = 直播型播放列表
      const pdts = [];                                 // 收集所有 #EXT-X-PROGRAM-DATE-TIME 时间戳
      const rePdt = /#EXT-X-PROGRAM-DATE-TIME:([^\r\n#]+)/g;
      let mp;
      while ((mp = rePdt.exec(r.text))) { const t = Date.parse(mp[1].trim()); if (!isNaN(t)) pdts.push(t); }
      if (isLive && pdts.length) {
        const ageSec = (Date.now() - Math.max.apply(null, pdts)) / 1000; // 最新 PDT 距今秒数
        if (ageSec > 300) return { state: "dead", kbps: 0, reason: "stale" + Math.round(ageSec) }; // 超 5 分钟即判「冻结/非直播」
      }
      // next 即真实分片：实测下载
      const s = await fetchSome(abs, Math.min(timeoutMs, 12000), CAP); // 分片：最多 12s（配合 600KB 小样本，弱源站可在宽限内下完→准确判定 slow/ok 而非误判 dead）
      if (s.status !== 200) return { state: "dead", kbps: 0, reason: "seg" + s.status };
      const kbps = estKbps(s);
      if (s.reason === "timeout" && s.total < 200 * 1024) return { state: "dead", kbps, reason: "seg-timeout" };
      if (s.reason === "end" && segDur > 0) {
        // ratio = 分片时长 ÷ 下载耗时（倍数，越大越快）：≥1.3 有富余=流畅；0.9~1.3 临界=偏慢；<0.9 下载慢于播放=跟不上
        const ratio = segDur / s.secs;
        return { state: ratio >= 1.3 ? "ok" : ratio >= 0.9 ? "slow" : "dead", kbps, ratio: +ratio.toFixed(2) };
      }
      return { state: kbps >= 1200 ? "ok" : kbps >= 300 ? "slow" : "dead", kbps };
    }
    u = abs; // 变体列表 → 继续跟下一层
  }
  return { state: "dead", kbps: 0, reason: "depth" };
}

let checkCache = null; // /api/check 结果 60s 缓存，避免重复点击重复拉流

// —— 后端中继代理：经本后端拉流再转发给浏览器，可突破「源站对国内 IP 的地理封锁」与跨域限制 ——
// 用法：/api/relay?url=<encodeURIComponent(m3u8)>；对播放列表内所有地址（含相对地址、密钥 URI）改写回本中继，
// 使 hls.js 后续的分片/密钥请求也全部走后端，整条链路不直接连境外源站。
function relayStream(req, res, u, depth = 0) {
  const target = u.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) { res.writeHead(400); res.end("bad url"); return; }
  let upstream;
  try { upstream = new URL(target); } catch (e) { res.writeHead(400); res.end("bad url"); return; }
  const isPlaylistUrl = /\.m3u8(\?.*)?$/i.test(target) || /\.m3u(\?.*)?$/i.test(target);
  // raw=1：原样返回播放列表、不做地址改写。回放站播放器用得上 —— 播放器手里的地址保持原样（.m3u8 后缀），
  // 它内部的 hls.js 才能正确识别 HLS；而它发出的网络请求已被注入脚本改走本中继，不依赖改写播放列表。
  const rawMode = u.searchParams.get("raw") === "1";
  const plKey = rawMode ? target + "#raw" : target; // 两种模式的缓存分开存，避免串味
  // 播放列表短期缓存命中：直接返回，省去一次上游往返（直播流回源频繁，缓存可显著降载、稳定输出）
  if (isPlaylistUrl) {
    const hit = plCache.get(plKey);
    if (hit && Date.now() - hit.ts < PL_CACHE_TTL) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      res.end(hit.body);
      return;
    }
  }
  // 分片缓存命中：预取已提前把该分片拉入内存，直接返回 → 几乎零等待（抗卡顿核心）
  if (!isPlaylistUrl) {
    const hit = segCacheGet(target);
    if (hit) {
      res.writeHead(200, { "Content-Type": hit.ct || "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "X-Relay-Cache": "HIT" });
      res.end(hit.buf);
      return;
    }
  }
  const mod = upstream.protocol === "https:" ? https : http;
  // Referer：默认用源站自身域名；若调用方通过 &ref= 指定（回放站播放器的防盗链只认播放器域名），
  // 则改用指定值 —— 仅接受白名单域名，避免变成「任意 Referer 注入」。
  let relayRef = upstream.origin + "/";
  const refRaw = u.searchParams.get("ref");
  if (refRaw) {
    try {
      const ru = new URL(refRaw);
      let ah = ""; try { ah = new URL(REPLAY_URL).hostname.replace(/^www\./i, ""); } catch (e) {}
      const rh = ru.hostname.replace(/^www\./i, "");
      const okRef = (ah && (rh === ah || rh.endsWith("." + ah))) || isPlayerHost(rh);
      if (okRef && (ru.protocol === "http:" || ru.protocol === "https:")) relayRef = ru.origin + "/";
    } catch (e) {}
  }
  const r = mod.request(target, {
    method: "GET",
    agent: upstream.protocol === "https:" ? relayHttpsAgent : relayHttpAgent, // 复用 keep-alive 连接，降低建连开销
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TvLiveRelay/1.0", "Referer": relayRef, "Connection": "keep-alive" },
    timeout: 20000
  }, (up) => {
    // 跟随上游 3xx 重定向（解锁 ccav.zone.id 这类 302 代理源 / 国内 CDN 跳转；深度上限 4 防环）
    if ([301, 302, 307, 308].includes(up.statusCode) && up.headers.location && depth < 4) {
      const loc = up.headers.location.startsWith("http") ? up.headers.location : new URL(up.headers.location, upstream).toString();
      up.resume();
      const u2 = new URL(req.url, `http://localhost:${PORT}`);
      u2.searchParams.set("url", loc);
      return relayStream(req, res, u2, depth + 1);
    }
    if (up.statusCode !== 200) { res.writeHead(up.statusCode || 502); res.end("upstream " + up.statusCode); return; }
    const ct = up.headers["content-type"] || "";
    const isPlaylist = /mpegurl|mpeg-ts|\.m3u8|text\/plain|application\/vnd\.apple|application\/x-mpegurl/i.test(ct)
      || /\.m3u8(\?.*)?$/i.test(target) || /\.m3u(\?.*)?$/i.test(target);
    if (isPlaylist) {
      let buf = "";
      up.setEncoding("utf8");
      up.on("data", (c) => { buf += c; });
      up.on("end", () => {
        const base = upstream;
        const rewrite = (line) => {
          // 改写密钥/映射 URI（#EXT-X-KEY / #EXT-X-MAP 中的 URI="..."）
          let out = line.replace(/URI="([^"]+)"/g, (m, p1) => {
            try { return 'URI="/api/relay?url=' + encodeURIComponent(new URL(p1, base).toString()) + '"'; }
            catch (e) { return m; }
          });
          // 改写独立的相对/绝对播放地址（变体、分段等）
          const t = out.trim();
          if (t !== "" && !t.startsWith("#")) {
            try { return "/api/relay?url=" + encodeURIComponent(new URL(t, base).toString()); }
            catch (e) { return out; }
          }
          return out;
        };
        const segUrls = []; // 收集本播放列表里的媒体分片（绝对地址），用于预取
        const out = buf.split(/\r?\n/).map((line) => {
          const tt = line.trim();
          if (tt !== "" && !tt.startsWith("#")) {
            try {
              const au = new URL(tt, base).toString();
              if (!/\.m3u8?(\?.*)?$/i.test(au)) segUrls.push(au); // 跳过子播放列表，只收真正的媒体分片
            } catch (e) {}
          }
          return rawMode ? line : rewrite(line);
        }).join("\n");
        plCachePut(plKey, out); // 写入播放列表缓存，供后续回源复用（降低上游压力、稳输出）
        if (segUrls.length) prefetchSegments(segUrls, relayRef); // 提前拉取接下来要播的分片（read-ahead）
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
        res.end(out);
      });
      up.on("error", () => { try { res.writeHead(502); res.end("relay upstream err"); } catch (e) {} });
    } else {
      // 分段 / 密钥等二进制：边透传边累积副本写入缓存（tee），客户端不等待、不延迟
      servingSeg.add(target);                     // 标记「播放端正在拉这一段」，让预取跳过 → 同一分片只下一次
      res.writeHead(200, { "Content-Type": ct || "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "X-Relay-Cache": "MISS" });
      const chunks = [];
      up.on("data", (c) => { chunks.push(c); });  // 累积一份副本用于写入分片缓存
      up.pipe(res);                               // 同时立即流式转发给客户端
      up.on("end", () => { try { segCachePut(target, Buffer.concat(chunks), ct); } catch (e) {} servingSeg.delete(target); });
      up.on("error", () => { try { res.end(); } catch (e) {} servingSeg.delete(target); });
    }
  });
  r.on("timeout", () => { r.destroy(); try { res.writeHead(504); res.end("relay timeout"); } catch (e) {} });
  r.on("error", () => { try { res.writeHead(502); res.end("relay error"); } catch (e) {} });
  req.on("close", () => { try { r.destroy(); } catch (e) {} });
  r.end();
}

// —— 回放站播放器「Referer 防盗链」支持（v0.3.13 修复「播放器播不了」的根因）——
// 实测结论（可用 curl 复现）：
//   回放站详情页里的播放器是另一个域名的 iframe（见 PLAYER_HOSTS）。该播放器按 Referer 白名单发放「真实播放地址」：
//     · Referer = 回放站域名          → 返回页面里带一段加密的真实流地址（能播）
//     · 其它任何 Referer（含我们的域名、空）→ 返回页面里根本没有这段流地址（播放器纯黑，怎么点都不播）
//   而真实流地址所在的 wiselife.blog 又做了第二层防盗链：只接受 Referer: https://xiaoca.top/，否则 403。
// 所以必须两处都由服务端代劳（浏览器不可能伪造跨域 Referer）：
//   ① 把播放器 iframe 也接进本代理，请求上游时把 Referer 补成回放站域名 → 播放器才肯发放播放地址；
//   ② 把播放器页里那段加密地址替换成「指回本服务中继」的地址，中继回源时再补上 Referer: <播放器域名>。
const PLAYER_HOSTS = ["xiaoca.top"]; // 回放站的播放器域名（日后换站可能需要加新的）
const isPlayerHost = (hh) => PLAYER_HOSTS.some((p) => hh === p || hh.endsWith("." + p));

// 播放器页注入脚本（放在 <head> 最前面，早于播放器自身脚本执行）：
// 把播放器发出的「站外请求」（真实流地址 wiselife.blog、分片 files3.imgtu.top 等）统统改走本服务中继，
// 由中继在服务端补上播放器要求的 Referer —— 浏览器不可能伪造跨域 Referer，这是唯一可行的做法。
// 注意：只改「网络请求」，不改播放器手里的地址字符串，播放器仍按 .m3u8 后缀正确识别 HLS。
const PLAYER_PATCH = `<script>(function(){
  var REF = "__REF__";
  function fix(u) {
    try {
      var abs = new URL(u, location.href);
      if (abs.origin === location.origin) return u;  // 已经是我们自己（同源）→ 不动
      if (/^(cdn\\.jsdelivr\\.net|code\\.jquery\\.com|cdnjs\\.cloudflare\\.com)$/.test(abs.hostname)) return u; // 公共脚本库不动
      return "/api/relay?url=" + encodeURIComponent(abs.toString()) + "&ref=" + encodeURIComponent(REF) + "&raw=1";
    } catch (e) { return u; }
  }
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    try { arguments[1] = fix(arguments[1]); } catch (e) {}
    return _open.apply(this, arguments);
  };
  if (window.fetch) {
    var _fetch = window.fetch;
    window.fetch = function (i, o) {
      try { if (typeof i === "string") i = fix(i); } catch (e) {}
      return _fetch.call(this, i, o);
    };
  }
})();</script>`;

// —— 回放站「内嵌代理」：把外部网页拉回本服务，再喂给前端 iframe ——
// 为什么需要它：回放站返回 X-Frame-Options: SAMEORIGIN + CSP frame-ancestors 'self'，浏览器会拒绝把它嵌进我们的页面（白屏）。
// 本函数做四件事，使该站能正常显示、并且「点进详情能播」：
//   ① 不透传「禁止被嵌套」的响应头（我们自己构造响应头，不带 X-Frame-Options / CSP）；
//   ② 页面内的相对资源（./resource/css、/img 等）统一补成「原站绝对地址」，否则会跑到我们域名下 404、页面裸奔；
//   ③ 站内导航链接（<a>、<form>）改写为走本代理，避免点击后在 iframe 内跳到原站又被它自己的 X-Frame-Options 拦成白屏；
//   ④ 播放器 iframe 也接进本代理并补上它要求的 Referer（见上面 PLAYER_HOSTS 说明），否则播放器不给流、永远黑屏。
// 用法：/api/embed?url=<encodeURIComponent(页面地址)>&ref=<需要发给上游的 Referer>
// 仅允许代理「回放站域名 + 已知播放器域名」，防止被当成开放代理滥用。
function embedPage(req, res, u, depth = 0) {
  const target = u.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) { res.writeHead(400); res.end("bad url"); return; }
  let upstream;
  try { upstream = new URL(target); } catch (e) { res.writeHead(400); res.end("bad url"); return; }
  // 域名白名单：只允许回放站主域及其子域（www. 前缀归一化比较）+ 已知播放器域名
  let allowHost = "";
  try { allowHost = new URL(REPLAY_URL).hostname.replace(/^www\./i, ""); } catch (e) {}
  const norm = (x) => String(x || "").replace(/^www\./i, "");
  const h = norm(upstream.hostname);
  const isReplayHost = !!allowHost && (h === allowHost || h.endsWith("." + allowHost));
  const playerPage = isPlayerHost(h); // 本次拉取的是不是「播放器页」
  if (!isReplayHost && !playerPage) { res.writeHead(403); res.end("host not allowed"); return; }
  const origin = upstream.origin + "/"; // 原站根地址：相对路径以它为基准解析

  // 上游 Referer：默认目标站自身域名；播放器页必须用「回放站域名」，由前端改写 iframe 时通过 &ref= 传进来
  let replayOrigin = origin;
  try { replayOrigin = new URL(REPLAY_URL).origin + "/"; } catch (e) {}
  const sanitizeRef = (raw) => {
    if (!raw) return "";
    try {
      const ru = new URL(raw);
      if (ru.protocol !== "http:" && ru.protocol !== "https:") return "";
      const rh = norm(ru.hostname);
      const ok = (allowHost && (rh === allowHost || rh.endsWith("." + allowHost))) || isPlayerHost(rh);
      return ok ? ru.origin + "/" : "";
    } catch (e) { return ""; }
  };
  const upstreamRef = sanitizeRef(u.searchParams.get("ref")) || origin;

  // 判断一个原始地址是否属于「当前页面所在的站点」：是则返回其绝对 URL，否则返回 null（站外 / 锚点 / js 伪协议等一律不动）
  const sameSite = (hh) => playerPage
    ? isPlayerHost(hh)
    : (!!allowHost && (hh === allowHost || hh.endsWith("." + allowHost)));
  function absIfSame(raw) {
    const t = String(raw || "").trim();
    if (!t || t.startsWith("#") || /^(javascript|mailto|tel|data|blob):/i.test(t)) return null;
    let abs;
    try { abs = new URL(t, upstream); } catch (e) { return null; } // 以「当前页面地址」为基准解析相对路径（子目录页面必须如此）
    return sameSite(norm(abs.hostname)) ? abs.toString() : null;
  }

  const mod = upstream.protocol === "https:" ? https : http;
  const r = mod.request(target, {
    method: "GET",
    agent: upstream.protocol === "https:" ? relayHttpsAgent : relayHttpAgent,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,ko;q=0.8,en;q=0.7",
      "Referer": upstreamRef
    },
    timeout: 20000
  }, (up) => {
    // 跟随上游 3xx 重定向（部分入口会跳到带参数的详情页；深度上限 4 防环）
    if ([301, 302, 307, 308].includes(up.statusCode) && up.headers.location && depth < 4) {
      const loc = new URL(up.headers.location, upstream).toString();
      up.resume();
      const u2 = new URL(req.url, "http://localhost"); // 只取 pathname + query
      u2.searchParams.set("url", loc);
      return embedPage(req, res, u2, depth + 1);
    }
    if (up.statusCode !== 200) { up.resume(); res.writeHead(up.statusCode || 502); res.end("upstream " + up.statusCode); return; }
    const ct = String(up.headers["content-type"] || "");
    if (!/text\/html|application\/xhtml/i.test(ct)) { // 非 HTML（图片/脚本等）：原样透传，让 iframe 内的资源请求也能借道本代理
      res.writeHead(200, { "Content-Type": ct || "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      return up.pipe(res);
    }
    const chunks = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      let html = Buffer.concat(chunks).toString("utf8");
      // ① 移除页面内的 CSP meta（frame-ancestors 会阻止被嵌套）
      html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
      // ② 导航链接（<a> / <form>）改走本代理，避免 iframe 内跳原站被拦成白屏（播放器页无导航，跳过）
      const navUrls = [];
      if (!playerPage) {
        const markNav = (tag) => tag.replace(/\b(href|action)=("([^"]*)"|'([^']*)')/i, (m, attr, q, dq, sq) => {
          const abs = absIfSame(dq !== undefined ? dq : sq);
          if (!abs) return m;
          navUrls.push("/api/embed?url=" + encodeURIComponent(abs));
          return attr + '="@@TVNAV' + (navUrls.length - 1) + '@@"';
        });
        html = html.replace(/<a\b[^>]*>/gi, markNav).replace(/<form\b[^>]*>/gi, markNav);
      }
      // ③ 其余资源（css / js / img 等）：相对与站内地址统一补成原站绝对地址，保证样式与封面能正常加载
      html = html.replace(/\b(href|src|action)=("([^"]*)"|'([^']*)')/gi, (m, attr, q, dq, sq) => {
        const raw = dq !== undefined ? dq : sq;
        if (/@@TVNAV\d+@@/.test(raw)) return m; // 上一步的占位符跳过
        const abs = absIfSame(raw);
        return abs ? attr + '="' + abs + '"' : m;
      });
      // ④ 还原导航占位符为本代理地址
      html = html.replace(/@@TVNAV(\d+)@@/g, (m, i) => navUrls[i] || "#");
      if (!playerPage) {
        // ⑤ 把「第三方播放器 iframe」也接进本代理，并带上 &ref=<回放站域名>：
        //    播放器只认回放站域的 Referer，而浏览器发出去的只会是我们自己的域名，必须由服务端代替浏览器去要。
        html = html.replace(/\bsrc=("([^"]*)"|'([^']*)')/gi, (m, q, dq, sq) => {
          const raw = dq !== undefined ? dq : sq;
          if (/@@TVNAV\d+@@/.test(raw)) return m;
          let abs; try { abs = new URL(raw, upstream); } catch (e) { return m; }
          if (!isPlayerHost(norm(abs.hostname))) return m;   // 只接管已知播放器域名，其余外链不动
          if (abs.pathname === "/api/embed") return m;       // 防自套
          return 'src="/api/embed?url=' + encodeURIComponent(abs.toString()) + "&ref=" + encodeURIComponent(replayOrigin) + '"';
        });
      } else {
        // ⑥ 播放器页：在 <head> 最前面注入一段脚本，把播放器的站外请求统统改走本服务中继
        //    （中继会在服务端补上播放器要求的 Referer: <播放器域名>，绕过流服务器的防盗链）。
        const patch = PLAYER_PATCH.replace("__REF__", origin);
        if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + patch);
        else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + patch);
        else html = patch + html;
      }
      // ⑦ 响应头不带 X-Frame-Options / CSP → 允许被本页 iframe 嵌套
      // ⑧ Referrer-Policy 与浏览器默认值保持一致，避免下游脚本/资源因策略差异被拒（回放站本身也不设该头）。
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      });
      res.end(html);
    });
  });
  r.on("error", () => { try { res.writeHead(502); res.end("embed error"); } catch (e) {} });
  r.on("timeout", () => { try { r.destroy(); } catch (e) {} });
  req.on("close", () => { try { r.destroy(); } catch (e) {} });
  r.end();
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  // /api/health 额外回报 SBS 动态 token 频道的状态（体育 + 主台），方便外部一眼看出「地址还有没有效」
  if (p === "/api/health") {
    const sbsAllExps = Object.values(sbsTokenExps).filter(Boolean);
    const sbsMin = sbsAllExps.length ? Math.min(...sbsAllExps) : null;
    return sendJson(res, {
      ok: true, version: VERSION, ts: Date.now(),
      sbsSports: {                                  // 动态 token 频道的健康信息
        exp: sbsMin,                               // 最早过期的 token 时间戳(ms)，null 表示尚未取到
        expiresInMin: sbsMin ? Math.round((sbsMin - Date.now()) / 60000) : null, // 剩余分钟数（负数=已过期）
        byId: sbsTokenExps                         // 各频道(id)的过期时间戳明细
      }
    });
  }
  if (p === "/api/channels") return sendJson(res, CHANNELS);
  // 前端配置：回放站默认地址（前端可被 localStorage 覆盖）
  if (p === "/api/config") return sendJson(res, { version: VERSION, replayUrl: REPLAY_URL });
  if (p === "/api/epg") {
    const cid = parseInt(u.searchParams.get("channelId") || "1", 10);
    return sendJson(res, { channelId: cid, programs: buildEpg(cid) });
  }
  // 源健康检测（深度）：真实拉取分片测吞吐，返回 {id: {state:"ok"|"slow"|"dead", kbps}}
  if (p === "/api/check") {
    const timeout = Math.min(parseInt(u.searchParams.get("timeout") || "6000", 10), 8000);
    const deep = u.searchParams.get("deep") !== "0";
    if (checkCache && Date.now() - checkCache.ts < 60000) { // 60s 内直接复用，避免重复拉流
      return sendJson(res, { ts: checkCache.ts, cached: true, count: CHANNELS.length, results: checkCache.results });
    }
    const results = {};
    if (!deep) {
      await Promise.all(CHANNELS.map(async (c) => { results[c.id] = { state: await probeStream(c.url, timeout) }; }));
    } else {
      const queue = CHANNELS.slice();
      const worker = async () => { // 并发 6：降低并发、给弱源站（如韩国小地方台）留足云端出口带宽，避免自检式超时误判 dead
        while (queue.length) {
          const c = queue.shift();
          try { results[c.id] = await checkDeep(c.url, timeout); }
          catch (e) { results[c.id] = { state: "dead", kbps: 0 }; }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    }
    checkCache = { ts: Date.now(), results };
    return sendJson(res, { ts: checkCache.ts, count: CHANNELS.length, results });
  }

  // 后端中继代理：浏览器经本后端拉流，可突破源站地理封锁 + 跨域
  if (p === "/api/relay") return relayStream(req, res, u);

  // 回放站内嵌代理：剥掉「禁止被 iframe 嵌套」的头，让外部回放站能嵌在本页里显示
  if (p === "/api/embed") return embedPage(req, res, u);

  // 静态托管 web/ 演示页（便于浏览器直接预览）
  const file = p === "/" ? "/index.html" : p;
  const filePath = path.join(__dirname, "web", file);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log(`TvLive backend v${VERSION} running: http://localhost:${PORT}`));
