// TvLive Web 演示：复用同源后端 /api/channels 与 /api/epg
// 功能：频道列表、点播（HLS 用 hls.js）、数字键盘切台、EPG 显示、收藏（localStorage）
// 与 Android 端共享同一后端契约，是「看得到流程」的验证入口（沙箱无模拟器时的替代）。

const BACKEND = ""; // 同源，留空即可；跨域部署时填 "http://<ip>:8899"
const FAV_KEY = "tvlive_fav";

let channels = [];
let current = null;
let favOnly = false;
const collapsedGroups = new Set(); // 已折叠（收纳）的分类名集合，点击分类头切换
let statusMap = {};            // 频道实测状态：{id: "ok"|"slow"|"dead"|"checking"}
let kbpsMap = {};              // 实测吞吐：{id: kbps}（后端深度探测得到）
let hls = null;
let fatalRetries = 0;          // HLS 致命错误自动重试计数（每次选台重置）
const MAX_FATAL_RETRIES = 4;   // 超过此次数仍失败才判定为真正故障
let relayOn = true;            // 后端中继代理开关（默认开：HLS 经本后端拉流，突破源站地理封锁）
const favSet = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]"));

const $ = (id) => document.getElementById(id);

// —— 1) 拉频道列表 ——
async function loadChannels() {
  const status = $("status");
  try {
    const r = await fetch(BACKEND + "/api/channels");
    channels = await r.json();
    status.textContent = "已连接 · " + channels.length + " 个频道";
    status.classList.add("ok");
    renderList();
    checkSources();   // 拉完列表即检测各源可达性（本机实际网络）
  } catch (e) {
    status.textContent = "后端未连接：" + e.message;
  }
}

function renderList() {
  const shown = favOnly ? channels.filter((c) => favSet.has(String(c.id))) : channels;
  $("chCount").textContent = shown.length + " / " + channels.length;
  const ul = $("chList");
  ul.innerHTML = "";

  // 按「分类」分组（保持频道列表中分类首次出现的顺序）
  const order = [];
  const buckets = {};
  shown.forEach((c) => {
    const g = c.group || "其他";
    if (!buckets[g]) { buckets[g] = []; order.push(g); }
    buckets[g].push(c);
  });

  order.forEach((g) => {
    const collapsed = collapsedGroups.has(g);
    // 分类头：可点击「收纳」按钮（▾ 展开 / ▸ 收起），点击向下展开/折叠该分类全部频道
    const head = document.createElement("li");
    head.className = "cat-head" + (collapsed ? " collapsed" : "");
    head.dataset.group = g;
    head.innerHTML =
      '<span class="arrow">' + (collapsed ? "▸" : "▾") + "</span>" +
      '<span class="cat-name">' + g + "</span>" +
      '<span class="cat-cnt">' + buckets[g].length + "</span>";
    head.title = collapsed ? "点击展开「" + g + "」" : "点击收纳「" + g + "」";
    head.onclick = () => toggleGroup(g);
    ul.appendChild(head);
    // 该分类下的频道（收起时整体隐藏）
    buckets[g].forEach((c) => ul.appendChild(buildChItem(c, collapsed)));
  });
}

// 构建单个频道行（选台 / 高亮 / 状态点逻辑与旧版一致）
function buildChItem(c, hidden) {
  const li = document.createElement("li");
  li.className = "ch-item" + (hidden ? " hidden" : ""); // hidden：所属分类被收纳时隐藏
  li.dataset.id = String(c.id);   // 记录频道 id，供选台时精准切换高亮，无需重绘整张列表
  if (current && c.id === current.id) li.classList.add("active");
  const st = statusMap[String(c.id)] || "checking";
  const kbps = kbpsMap[String(c.id)];
  const title = ({ ok: "实测可流畅播放", slow: "可连但偏慢，可能卡顿", dead: "源不可用/过慢", checking: "检测中" }[st] || st) + (kbps ? "（约 " + kbps + " kbps）" : "");
  const logo = c.logo
    ? '<img class="ch-logo" src="' + c.logo + '" onerror="this.style.display=\'none\'" alt="">'
    : "";
  li.innerHTML =
    '<span class="status-dot ' + st + '" title="' + title + '"></span>' +
    '<span class="no">' + c.id + "</span>" +
    logo +
    '<span class="nm">' + c.name + '<div class="grp">' + (c.group || "") + "</div></span>" +
    (favSet.has(String(c.id)) ? '<span class="star">★</span>' : "");
  li.onclick = () => selectChannel(c);
  return li;
}

// 分类收纳：点击分类头折叠/展开该分类下所有频道
function toggleGroup(g) {
  if (collapsedGroups.has(g)) collapsedGroups.delete(g);
  else collapsedGroups.add(g);
  renderList();
}

// 仅切换「当前选中行」高亮，不重建整张列表（避免每次选台都重绘所有 logo / 圆点）
function updateActive() {
  const items = $("chList").querySelectorAll("li[data-id]");
  items.forEach((li) => {
    li.classList.toggle("active", !!current && li.dataset.id === String(current.id));
  });
}

// 调用后端 /api/check，刷新每个频道的可达性绿/红点
async function checkSources() {
  if (!channels.length) return;
  // 先把所有标为检测中
  channels.forEach((c) => { statusMap[String(c.id)] = "checking"; });
  renderList();
  try {
    // 深度探测：后端会真实拉取一个分片测吞吐（ok 流畅 / slow 偏慢 / dead 不可用），比旧版「列表能否返回」准确得多
    const r = await fetch(BACKEND + "/api/check?timeout=6000");
    const d = await r.json();
    statusMap = {}; kbpsMap = {};
    Object.entries(d.results || {}).forEach(([id, v]) => {
      statusMap[id] = (typeof v === "string") ? v : (v && v.state) || "dead";
      if (v && v.kbps) kbpsMap[id] = v.kbps;
    });
    let okN = 0, slowN = 0, deadN = 0;
    Object.values(statusMap).forEach((v) => { if (v === "ok") okN++; else if (v === "slow") slowN++; else if (v === "dead") deadN++; });
    const s = $("status");
    s.textContent = "已连接 · " + channels.length + " 个频道 · 实测 流畅 " + okN + " / 偏慢 " + slowN + " / 不可用 " + deadN + (d.cached ? "（缓存）" : "");
    s.classList.add("ok");
  } catch (e) {
    $("status").textContent = "健康检测失败：" + e.message;
  }
  renderList();
}

// —— 2) 选台 + 播放 ——
function showStageMsg(text, kind) {
  const el = $("stageMsg");
  el.textContent = text;
  el.className = "stage-msg" + (kind ? " " + kind : "");
  el.classList.remove("hidden");
}
function hideStageMsg() { $("stageMsg").classList.add("hidden"); }

// 安全销毁 HLS 实例（避免重复销毁抛错）
function safeDestroyHls() {
  if (hls) { try { hls.destroy(); } catch (_) {} hls = null; }
}

function selectChannel(ch) {
  current = ch;
  updateActive();   // 只切换高亮，不重绘整张列表（logo/圆点保持不动）
  // 后端探测为不可达的源：给出提示但仍允许尝试（你的浏览器网络可能与后端不同，以实际播放为准）
  if (Object.keys(statusMap).length && statusMap[String(ch.id)] === "dead") {
    showStageMsg("「" + ch.name + "」在后端探测中不可达，仍尝试播放（你的浏览器网络可能不同）。", "loading");
  }
  $("playHint").style.display = "none";
  loadEpg(ch);

  const video = $("video");
  if (hls) safeDestroyHls();
  const isHls = /m3u8/i.test(ch.url);
  hideStageMsg();

  if (isHls) {
    // HLS：需要 hls.js（已本地化托管）
    if (window.Hls && Hls.isSupported()) {
      fatalRetries = 0;
      // 单频道可用 relay:false 强制本机直连（如国内源上海中继不可达时）；否则跟随全局中继开关
      const useRelay = relayOn && ch.relay !== false;
      const relayTag = useRelay ? "（经后端中继）" : "（本机直连）";
      showStageMsg("正在加载「" + ch.name + "」" + relayTag + "…", "loading");
      // HLS 走后端中继（默认开），由后端拉流转发，可突破源站对国内 IP 的地理封锁
      const hlsSrc = useRelay ? ("/api/relay?url=" + encodeURIComponent(ch.url)) : ch.url;
      hls = new Hls({
        enableWorker: true,
        // —— 缓冲/重试参数：针对「远距离/不稳定源」大幅增强容错，压住卡顿 ——
        maxBufferLength: 60,          // 目标前向缓冲 60s（更大缓冲消化抖动）
        maxMaxBufferLength: 120,      // 缓冲上限 120s
        backBufferLength: 30,         // 保留 30s 后向缓冲，减少回跳重缓冲
        // 关键修正：中继代理会给直播流引入额外网络延迟 → 播放位置落后直播边缘；
        // 旧配置允许最高 1.5x 追帧，于是表现为「播放速度变快 1.5~2 倍」。现禁用追帧，永远 1x 正常速度。
        liveSyncDuration: 20,         // 落后直播 20s，留出稳定缓冲，但不靠加速追帧
        maxLiveSyncPlaybackRate: 1,   // 永远不超过 1x 播放（彻底消除「变快」问题）
        // 抗卡顿增强：
        capLevelToPlayerSize: true,   // 不拉超过播放器分辨率的高码率档 → 省带宽=更稳
        enableWebVTT: false,          // 跳过字幕轨拉取（很多台字幕轨会触发额外失败/重试）
        lowLatencyMode: false,        // 关低延迟模式，换取更稳的缓冲
        nudgeOffset: 0.1,             // 直播同步微调（温和，不触发加速）
        nudgeMaxRetry: 5,
        maxStarvationDelay: 8,        // 缓冲耗尽时最多等 8s 再报错，给远端更多恢复时间
        fragLoadingMaxRetry: 15,      // 单个分片加载最多重试 15 次
        fragLoadingRetryDelay: 1000,  // 重试间隔 1s（指数退避由库内置）
        fragLoadingMaxRetryTimeout: 12000,
        manifestLoadingMaxRetry: 8,   // 播放列表加载重试
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 8,      // 码率档位列表加载重试
        levelLoadingRetryDelay: 1000,
        abrEwmaDefaultEstimate: 500000 // 开局带宽估计 500kbps（远距离源更保守，首段不卡）
      });
      hls.loadSource(hlsSrc);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { hideStageMsg(); video.play().catch(()=>{}); });
      // 分片成功加载 → 说明自动重连已生效，重置重试计数并收起提示
      hls.on(Hls.Events.FRAG_LOADED, () => {
        if (fatalRetries > 0) { fatalRetries = 0; hideStageMsg(); }
      });
      hls.on(Hls.Events.ERROR, (e, data) => {
        if (!data || !data.fatal) {
          // 非致命错误（如单个分片偶发失败）由 hls.js 自带重试处理，不提示
          console.warn("[hls] non-fatal:", data && data.details);
          return;
        }
        // 致命错误：先尝试自动恢复，避免直接黑屏/报错
        console.warn("[hls] fatal:", data.details, "type:", data.type, "retry:", fatalRetries);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (fatalRetries < MAX_FATAL_RETRIES) {
            fatalRetries++;
            showStageMsg("网络波动，正在自动重连（" + fatalRetries + "/" + MAX_FATAL_RETRIES + "）…", "loading");
            hls.startLoad();                       // 重新拉取分片
          } else {
            showStageMsg("多次重连失败：测试流可能不稳定或网络受限，请稍后重试或换频道。", "error");
            safeDestroyHls();
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (fatalRetries < MAX_FATAL_RETRIES) {
            fatalRetries++;
            showStageMsg("解码异常，正在自动恢复（" + fatalRetries + "/" + MAX_FATAL_RETRIES + "）…", "loading");
            try { hls.recoverMediaError(); } catch (_) { safeDestroyHls(); }
          } else {
            showStageMsg("多次解码恢复失败：测试流可能不稳定或不兼容，请换频道。", "error");
            safeDestroyHls();
          }
        } else {
          // 其他致命错误（如密钥/多路复用）无法自动恢复
          showStageMsg("无法恢复的播放错误（" + (data.details || data.type) + "）。", "error");
          safeDestroyHls();
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = ch.url; // Safari 原生 HLS
      video.play().catch(()=>{});
    } else {
      showStageMsg("本浏览器无法加载 hls.js，HLS 流无法播放。", "error");
    }
  } else if (/^https?:/i.test(ch.url) && video.canPlayType("video/mp4")) {
    // 原生 MP4：浏览器直接播放，零依赖
    showStageMsg("正在加载「" + ch.name + "」…", "loading");
    video.src = ch.url;
    video.play().catch(()=>{});
  } else {
    // RTSP / RTMP 浏览器无法直接播放，仅 App 端支持
    showStageMsg("「" + ch.name + "」为 " + ch.url.split(":")[0].toUpperCase() +
      " 源，浏览器无法播放，请在 Android App 端观看。", "error");
    video.removeAttribute("src");
    video.load();
    clearWatchdog();   // 该源本就不支持网页播放，无需看门狗
  }
  armWatchdog(ch);     // 其余可播分支启用看门狗，防止无限「缓冲中」
  updateFavBtn();
}

// 原生 <video> 错误监听（兜底提示，HLS 流由 hls.js 处理器主导，避免重复提示）
$("video").addEventListener("error", () => {
  if (hls) return; // HLS 流交给上面的 hls.js 错误处理器，不在这里抢提示
  if (!current) return;
  const v = $("video");
  const code = v.error ? v.error.code : 0;
  showStageMsg("视频解码/加载出错（code " + code + "）。请换一个频道，或检查网络是否可访问该流。", "error");
});
// 播放看门狗：选台后若长时间仍无法进入播放，给出明确结论，避免无限「缓冲中」干等
let watchTimer = null;
function clearWatchdog() { if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; } }
function armWatchdog(ch) {
  clearWatchdog();
  watchTimer = setTimeout(() => {
    const v = $("video");
    if (!current || current.id !== ch.id) return;   // 期间已切台
    if (!v.paused && v.currentTime > 0.2) return;   // 已在正常播放
    showStageMsg("「" + ch.name + "」长时间无画面：该源当前跨洋带宽不足或已不可用。\n建议换台；可点「重测可达性」查看各台真实状态。", "error");
  }, 16000);
}

// 持续缓冲监测：单次缓冲超过 12s 仍未恢复 → 判定为「源过慢」，而非普通缓冲
let waitTimer = null;
$("video").addEventListener("waiting", () => {
  showStageMsg("缓冲中…", "loading");
  if (waitTimer) clearTimeout(waitTimer);
  waitTimer = setTimeout(() => {
    if ($("video").readyState < 3) showStageMsg("持续缓冲超过 12 秒：该源当前过慢，建议换台。", "error");
  }, 12000);
});
$("video").addEventListener("playing", () => {
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
  clearWatchdog();
  hideStageMsg();
});

// —— 3) EPG ——
async function loadEpg(ch) {
  try {
    const r = await fetch(BACKEND + "/api/epg?channelId=" + ch.id);
    const d = await r.json();
    const now = Date.now();
    const cur = d.programs.find((p) => now >= p.start && now < p.end);
    const nxt = d.programs.find((p) => p.start > now);
    $("epgTitle").textContent = ch.name + " · 节目单";
    $("epgNow").textContent = "正在播出：" + (cur ? cur.title : "—");
    $("epgNext").textContent = "接下来：" + (nxt ? nxt.title : "—");
  } catch (e) {
    $("epgNow").textContent = "EPG 获取失败";
  }
}

// —— 4) 收藏 ——
function toggleFav() {
  if (!current) return;
  const k = String(current.id);
  if (favSet.has(k)) favSet.delete(k); else favSet.add(k);
  localStorage.setItem(FAV_KEY, JSON.stringify([...favSet]));
  updateFavBtn();
  renderList();
}
function updateFavBtn() {
  const on = current && favSet.has(String(current.id));
  const b = $("btnFav");
  b.textContent = on ? "★ 已收藏" : "☆ 收藏当前频道";
  b.classList.toggle("on", !!on);
}
function toggleFilter() {
  favOnly = !favOnly;
  const b = $("btnFilter");
  b.textContent = favOnly ? "显示全部" : "仅看收藏";
  b.classList.toggle("active", favOnly);
  renderList();
}
function toggleRelay() {
  relayOn = !relayOn;
  const b = $("btnRelay");
  b.textContent = relayOn ? "中继：开" : "中继：关";
  b.classList.toggle("on", relayOn);
  // 立即按新设置重连当前 HLS（若当前就是 HLS 源）
  if (current && /m3u8/i.test(current.url)) selectChannel(current);
}

// —— 5) 数字键盘切台（模拟遥控器）——
const numBuf = [];
function pushDigit(d) {
  if (numBuf.length < 4) numBuf.push(d);
  $("numBuffer").textContent = numBuf.join("");
  $("numPad").classList.remove("hidden");
}
function commitNum() {
  const n = parseInt(numBuf.join(""), 10);
  numBuf.length = 0;
  $("numBuffer").textContent = "";
  if (!isNaN(n)) {
    const ch = channels.find((c) => c.id === n);
    if (ch) selectChannel(ch);
  }
  $("numPad").classList.add("hidden");
}
function clearNum() { numBuf.length = 0; $("numBuffer").textContent = ""; }

$("btnFav").onclick = toggleFav;
$("btnFilter").onclick = toggleFilter;
$("btnCheck").onclick = checkSources;   // 一键重新检测各源可达性
$("btnRelay").onclick = toggleRelay;    // 后端中继代理开关
document.querySelectorAll(".pad-grid button").forEach((b) => {
  b.onclick = () => {
    const d = b.dataset.d;
    if (d === "ok") commitNum();
    else if (d === "x") clearNum();
    else pushDigit(d);
  };
});

// 键盘事件：数字键弹键盘，Enter 切台，F 收藏，P 筛选
document.addEventListener("keydown", (e) => {
  if (e.key >= "0" && e.key <= "9") { pushDigit(e.key); e.preventDefault(); }
  else if (e.key === "Enter") { commitNum(); e.preventDefault(); }
  else if (e.key === "f" || e.key === "F") toggleFav();
  else if (e.key === "p" || e.key === "P") toggleFilter();
});

// —— 6) 直播 / 回放 双模式 ——
// 回放走「外部站点」：点按钮在新窗口打开，同时尝试内嵌。
// 因回放地址可能经常变，支持在页面内直接修改并存 browsers localStorage（覆盖后端默认值），无需改代码/重新部署。
const REPLAY_KEY = "tvlive_replay_url";   // 本地覆盖键
let replayDefault = "";                    // 后端 /api/config 下发的默认地址
let replayUrl = "";                        // 当前生效地址（本地覆盖 > 默认）
let replayMsgTimer = null;

async function loadConfig() {
  try {
    const r = await fetch(BACKEND + "/api/config");
    const d = await r.json();
    replayDefault = (d && d.replayUrl) || "";
  } catch (e) { replayDefault = ""; }
  const saved = localStorage.getItem(REPLAY_KEY);
  replayUrl = (saved || replayDefault || "").trim();
  const inp = $("replayUrlInput");
  if (inp) inp.value = replayUrl;
  // 若启动时就处于回放模式（#replay 深链），等地址就绪后把内嵌窗口加载出来
  const wrap = $("replayWrap");
  if (wrap && !wrap.classList.contains("hidden") && replayUrl) loadReplayFrame();
}

// 取当前输入框/生效地址（优先输入框，其次生效值）
function currentReplayUrl() {
  return (($("replayUrlInput").value || replayUrl) || "").trim();
}

// 把「回放站地址」转成后端内嵌代理地址：由后端拉取该页面、剥掉「禁止被嵌套」的响应头再喂给 iframe，
// 于是外部回放站就能直接显示在本页里 —— 这是「直播 / 回放自由切换」的关键。
function replayEmbedSrc(url) {
  const t = (url || "").trim();
  return t ? (BACKEND + "/api/embed?url=" + encodeURIComponent(t)) : "about:blank";
}

// 加载内嵌回放页（进入回放模式、点「刷新」/「回默认页」、保存新地址时调用）
function loadReplayFrame() {
  const frame = $("replayFrame");
  if (!frame) return;
  const url = currentReplayUrl();
  if (!url) return; // 地址尚未就绪（如启动时配置还没加载完）→ 静默跳过，等配置到了再加载
  frame.src = replayEmbedSrc(url);
  frame.dataset.loaded = "1";
}

function replayMsg(t) {
  const el = $("replayMsg");
  if (!el) return;
  el.textContent = t;
  if (replayMsgTimer) clearTimeout(replayMsgTimer);
  replayMsgTimer = setTimeout(() => { el.textContent = ""; }, 4000);
}

// 切换模式：直播 <-> 回放：切回直播时暂停视频并卸载回放窗口（避免后台继续播放/耗流量）；
// 切到回放时恢复上次浏览的页面，没有则加载默认页。同步 URL hash（#replay / #live），便于分享直达。
let lastFrameSrc = ""; // 记住切走前回放窗口的地址，切回来可原位恢复
function setMode(m, updateHash) {
  const live = m === "live";
  $("liveWrap").classList.toggle("hidden", !live);
  $("replayWrap").classList.toggle("hidden", live);
  $("btnModeLive").classList.toggle("active", live);
  $("btnModeReplay").classList.toggle("active", !live);
  const frame = $("replayFrame");
  if (live) {
    try { $("video").pause(); } catch (_) {}   // 离开直播页时暂停，省资源
    // 卸载内嵌窗口（切成空白页），彻底停止回放视频的后台播放
    if (frame && frame.dataset.loaded === "1") { lastFrameSrc = frame.src; frame.src = "about:blank"; frame.dataset.loaded = "0"; }
  } else if (frame) {
    if (lastFrameSrc) { frame.src = lastFrameSrc; lastFrameSrc = ""; frame.dataset.loaded = "1"; }
    else if (frame.dataset.loaded !== "1") loadReplayFrame();
  }
  if (updateHash !== false) {
    try { history.replaceState(null, "", live ? "#live" : "#replay"); } catch (_) {}
  }
}

function openReplay() {
  const url = currentReplayUrl();
  if (!url) { replayMsg("请先填写回放地址"); return; }
  // 新窗口打开（noopener 防钓鱼）；部分浏览器会拦截，若无反应请用「在本页打开」
  const w = window.open(url, "_blank", "noopener");
  if (!w) replayMsg("新窗口可能被浏览器拦截，请点「在本页打开」");
}

// 刷新内嵌窗口（重新加载当前页；未加载过则加载默认页）
function reloadReplayFrame() {
  const frame = $("replayFrame");
  if (!frame) return;
  if (frame.dataset.loaded === "1" && frame.src && frame.src !== "about:blank") frame.src = frame.src;
  else loadReplayFrame();
  replayMsg("已刷新回放窗口");
}

// 跳过站内当前浏览位置，直接回到回放站默认页
function replayGoHome() {
  lastFrameSrc = "";
  loadReplayFrame();
  replayMsg("已回到默认页");
}

function saveReplay() {
  const url = ($("replayUrlInput").value || "").trim();
  if (!url) { replayMsg("请先填写回放地址"); return; }
  replayUrl = url;
  localStorage.setItem(REPLAY_KEY, url);
  lastFrameSrc = "";
  loadReplayFrame();
  replayMsg("已保存到本机浏览器，并已载入新地址");
}

function resetReplay() {
  localStorage.removeItem(REPLAY_KEY);
  replayUrl = (replayDefault || "").trim();
  $("replayUrlInput").value = replayUrl;
  lastFrameSrc = "";
  loadReplayFrame();
  replayMsg("已恢复默认地址");
}

$("btnModeLive").onclick = () => setMode("live");
$("btnModeReplay").onclick = () => setMode("replay");
$("btnReplayOpen").onclick = openReplay;
$("btnReplayReload").onclick = reloadReplayFrame;
$("btnReplayHome").onclick = replayGoHome;
$("btnReplaySave").onclick = saveReplay;
$("btnReplayReset").onclick = resetReplay;

// 启动（支持 #replay 深链直达回放模式）
loadChannels();
loadConfig();
setMode(location.hash === "#replay" ? "replay" : "live", false);
window.addEventListener("hashchange", () => setMode(location.hash === "#replay" ? "replay" : "live", false));
