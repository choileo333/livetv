# 变更记录 — TvLive 安卓 App

> 规范：文件名含版本号；程序内标注版本号；本文件逐版记录「时间 + 改了什么 + 为什么」。

---

## v1.4.1 — 2026-10-13 09:1x（回放页真正播出来：取流修复 + 反调试加固 + 播放器兜底）

### 来源：用户第七轮反馈
原话：「红点🔴移动啊，点击啊 都还尚可，就是这个具体视频没有加载出来，你看下我圈出来的这个信息，看看怎么改善」
截图圈了两处：① 提示条「⚠ 视频状态：页面里找不到 video 元素（播放器未渲染出来）」；② 红点下方浮出的 `(function(){ var REF =…`（**我们注入的补丁脚本源码被当成正文渲染出来了**）。

### 一、先复现、再定性（全部线上实测，不猜）

| 步骤 | 工具 | 得到的事实 |
|---|---|---|
| ① 站点结构 | `probe_play_page.js` | 详情页里 `<iframe id="view_iframe" src="/api/embed?url=<播放器页 onet.php>">`；广告遮罩 `#adFrame` 6 秒倒计时后由站点脚本 `showVideo()` 放开 |
| ② 页面为何整块消失 | `probe_timeline.js` / `probe_nav.js` | 站点挂了**两套反调试**。其一 `disable-devtool`：判定后把**主帧导航到 about:blank**（控制台留 `You don't have permission to use DEVTOOL!【type = 6】`）。其二 `disabledev2.js`：`console.clear(); before=Date.now(); debugger; after=Date.now();` 超 200ms 就 `document.write(...)` 清空页面。其三 onet.php 里 inline 的 `toDevtools()`：`console.log('', devtools)` 靠自定义 `toString` 被序列化次数跳 `error0.html` |
| ③ **取流地址是错的（本轮最重要的发现）** | `probe_m3u8_fresh.js` / `probe_stream_net.js` / 手工解 `common.js` | iframe src 里那串 `https://wiselife.blog/pop/<id>.m3u8` **不是可播地址**：无论送什么 Referer 都恒返 **404**。真正的流是播放器页全局变量 `vid`，形如 `https://wiselife.blog/hls/<id>.m3u8?t=..&n=..&s=..`（**带服务端签名**，每次请求都变）。网络流水证实站点自己请求的就是 `hls/...`，200 / `application/vnd.apple.mpegurl` / 97738B |
| ④ 为何站点自己没事、我们自建就挂 | 同上 | v1.4.0 的 `pickStream()` 只解**一层**编码，拿到的是**播放器页地址**（91 字符）而不是 m3u8，喂给 hls.js 得到 `manifestParsingError` —— 白等一场 |
| ⑤ 页面在真机上何时会被清空 | 反调试三连 + 缓存 | `shouldInterceptRequest` 只对**网络请求**生效；反调试脚本一旦进了 HTTP 缓存，**缓存命中不产生请求 → 回调不触发 → 拦截「时灵时不灵」** |

**结论**：黑屏不是解码问题，是三件事叠在一起 ——
(a) 取流地址取错了（必然播不出来）；(b) 反调试脚本会把页面整个清掉；(c) 站点播放器在老内核上可能压根没建出来（页面里连 video 元素都没有）。

### 二、改了什么

**A. 取流：改读播放器页的 `vid`（`ReplayRescueScript` v2 → v3，核心修复）**
- 新增 `readVid(frame)`：读同源 iframe 的 `window.vid`。iframe 经本后端 `/api/embed` 代理，与顶层**同源**，可直读。
- **为什么这条路最稳**：`common.js` 是**同步**脚本，`vid` 挂在 iframe 顶层作用域 —— **即使 Artplayer/jQuery 全挂掉，`vid` 也已经有值**，正好适配「播放器没建出来」这个兜底场景。不去自己复刻 base64+XOR，直接读站点解好的结果。
- 新增 `isM3u8(u)`：要求 **pathname 真的以 `.m3u8` 结尾**，废掉 `indexOf('.m3u8')` —— 后者会把 `onet.php?url=xxx.m3u8` 这种「m3u8 只是查询参数」误判成可播地址（v2 就栽在这）。
- 新增 `refOf(purl)`：Referer 取**播放器页自己的 origin**（`https://xiaoca.top/`）。实测流服务器只认它，送别的域一律 404。
- `scanStreams` → `walkVid`（逐层下钻同源 iframe，每轮记录最新 vid）；`tick()` 取流优先级改为 `readVid(frame)` → `lastStream`。

**B. 反调试加固（MainActivity）**
| 改动 | 为什么 |
|---|---|
| `settings.cacheMode = LOAD_NO_CACHE` | 缓存命中不产生网络请求 ⇒ `shouldInterceptRequest` 不被回调 ⇒ 拦截时灵时不灵。这正是「同一步操作有时黑屏、有时不黑」的来源 |
| 新增 `shouldOverrideUrlLoading` + `ERROR_PAGE_RE` | `shouldInterceptRequest` 拦不了**导航**；`toDevtools()` 是 **inline 脚本**（写在 HTML 里，换不掉），只能等它跳转时把门关上（拦 `error0.html` / `live_error.html`） |
| 新增 `onPageStarted` 注入 | `onPageFinished` 要等整页加载完，那时反调试脚本早跑完了。两处都注入是刻意的——脚本自带版本号短路，重复无害、漏注入有害 |

**C. 诊断改进（`TvNavScript` v5 → v6）**
- `caps()` 增加网页内核版本（`kernel=Chrome/NN`）：区分「设备太老」与「我们代码错」的关键证据；
- 新增 `videoDiag()`，把笼统的「找不到 video」拆成三种：**真没有 / 有但全被隐藏 / 有可见但没在播**（v1.3.0 那句笼统提示曾把排查带偏过一次，就是用户这次截图里那条）；
- `showDiag()` 改为**根因优先**（`SEVERE_RE` 命中项优先显示）+ 末尾标「共 N 条」；翻页时 `webDiag.clear()`。

**D. 播放器兜底（`ReplayRescueScript`）**
站点播放器 9 秒还没建出来就自己建一个（绝对定位、z-index 11 压过广告的 10），取流走本后端中继 `/api/relay?...&raw=1`（服务端补 Referer 绕防盗链）；优先复用播放器页已加载的 hls.js 0.14.17（ES5），否则从后端同源取 `/hls.min.js`；无 MSE 时退化成系统原生 HLS；45 秒后收手，不做无限重试。

### 三、验证（线上真跑，不是自检）
| 脚本 | 结果 |
|---|---|
| `verify_rescue_live.js`（三场景线上） | **15 通过 / 0 失败**。场景二关键证据：兜底前 `videos=0 alive=no`，兜底后 **`readyState=4`、解码尺寸 `1280×720`、`currentTime=0.9s`** —— 自建播放器真的在出画面 |
| `verify_tvnav.js`（静态 + 无头真按键） | **109 / 0** |
| `verify_scroll_live.js` | **10 / 0**（顺手把写死的播放页 id 改成现抓，旧 id 失效会产生假失败） |
| `verify_hls_chain.js` | **14 / 0** |
| `verify_backend_endpoints.js` | **12 / 0** |
| `verify_channel_parity.js` | **11 / 0** |
| `:app:testDebugUnitTest` | **15 / 15** |

APK：`tvlive-android-v1.4.1.apk`（versionCode 9）。已核对 dex 内含 `error0\.html`、`shouldOverrideUrlLoading`、`onPageStarted`、`__tvrescue_video`、`已自建播放器接管播放`、`/api/relay?url=`、`hls.min.js` 等本轮新增符号。

### 四、仍然不确定的地方（如实说明）
1. **真机上反调试脚本是否必然触发**：桌面无头端复现率约 50%（另一半是站点拉 jsdelivr 就失败）。电视盒子上的实际触发率**没有真机证据**——这正是本次把「三重防御 + 自动重载 + 诊断回显」都做上的原因：无论触发不触发都有兜底，且出事时用户拍屏就能带回根因。
2. **极老内核跑不跑得动 `/hls.min.js`（1.7.3）**：压测确认是 ES5（零箭头函数/class/let/const），但**未在真机验证**。这也是保留「复用站点 hls.js 0.14.17 优先 + 无 MSE 退化原生 HLS」两条退路的原因。
3. 站点内容/接口随时可能变；`pop/<id>.m3u8` 恒 404 这一点是**多次实测**的结论，但站点换源后可能又不一样 —— 所以取流逻辑不再依赖它。

---

## v1.4.2 — 2026-10-13 10:1x（真机反馈「vid 未定义」：兜底脚本自己解密真实流地址）

### 来源：用户第八轮反馈（v1.4.1 真机实测）
原话：「看起来最后兜底的也没能正常显示出来，，有没有一种可能是因为电视太老了不能渲染出来这个播放器呢，，你看看还有没有别的解决方案」
截图显示：
- `网页 JS 报错：Uncaught ReferenceError: vid is not defined @ code.jquery.com/jquery-3.6.4.min.js?v=50:2（共 6 条）`
- `播放器兜底：页面里没有能播的 video，也拿不到真实流地址（播放器页没加载出来或跨域），无法自建播放`

### 一、先定性（线上实测 + 复现）

- `vid is not defined` 发生在 onet.php 的 inline 脚本里（`var hls_url = vid;`），说明 **common.js 没有成功定义 `vid`**。
- 在 v1.4.1 的代码里，兜底脚本只读 `iframe.contentWindow.vid`；这个变量一旦没有，我们就束手无策 —— 于是上报「拿不到真实流地址」。
- 站点真正的流地址只能用 `common.js` 的解密算出：`vid = base64_decode(xor(base64_decode(phpsiteEc2), phpsitekey3))`。
- 关键事实是：**`phpsiteEc2` 和 `phpsitekey3` 是内联在 onet.php HTML 里的**，即使 common.js 没执行，HTML 里也有这俩原料。
- 用 Python 复刻 common.js 的 base64+XOR 解密，解出的 `vid` 与网络流水里站点自己请求的 `https://wiselife.blog/hls/<id>.m3u8?t=...&n=...&s=...` 完全一致。

### 二、改了什么

**A. `ReplayRescueScript` v3 → v4：读不到 `window.vid` 时自己解密**
- 新增 `base64Decode(data)`：纯 ES5 实现，不依赖老内核的 `atob`；
- 新增 `xorKey(s, key)`：循环 XOR；
- 新增 `extractVar(html, name)`：从 HTML 文本里提取 `var name = "value"`；
- 新增 `decodeVidFromHtml(html)`：组合上述三步，自己算出真实流地址；
- `readVid(frame)` 增加 fallback：先读 `frame.win.vid`，再读 `frame.doc.vid`，再没有就读 `frame.doc.documentElement.outerHTML` 自己解密。

**B. 更新验证脚本覆盖真机同构场景**
- `verify_rescue_live.js` 场景二预注入：除了让 `Artplayer` 取到 `undefined`，还阻止 `window.vid` 被赋值，强制兜底脚本走「HTML 自解密」路径；
- `verify_tvnav.js` 增加静态检查项：确认兜底脚本有 `decodeVidFromHtml` / `base64Decode` / `xorKey` / `phpsiteEc2` / `phpsitekey3`。

### 三、验证（线上真跑）

| 脚本 | 结果 |
|---|---|
| `verify_rescue_live.js`（三场景线上，含 vid 被锁死场景） | **15 通过 / 0 失败**。场景二关键证据：`vid` 被强制 undefined 后，兜底脚本自己解密 HTML 拿到真实流，自建播放器 `readyState=4`、解码尺寸 `1280×720`、`currentTime=1.8s` |
| `verify_tvnav.js` | **115 / 0** |
| `verify_scroll_live.js` | **10 / 0** |
| `verify_hls_chain.js` | **14 / 0** |
| `verify_backend_endpoints.js` | **12 / 0** |
| `verify_channel_parity.js` | **11 / 0** |
| `:app:testDebugUnitTest` | **15 / 15** |

APK：`tvlive-android-v1.4.2.apk`（versionCode 10）。已核对 dex 内含 `decodeVidFromHtml`、`base64Decode`、`xorKey`、`phpsiteEc2`、`phpsitekey3` 等本轮新增符号。

### 四、仍然不确定的地方（如实说明）
1. **为什么真机上 common.js 没执行**：可能是缓存命中、网络抖动、WebView 对某个跨域脚本的处理差异，或 jsdelivr 在特定网络下失效。现在我们已经不再依赖它执行，所以这个问题被绕过，但根因仍未在真机上定位。
2. **老电视盒子是否真的「渲染不出来播放器」**：目前所有线上验证都证明自建播放器能渲染并出画面；如果 v1.4.2 在真机上仍黑屏，需要再拍状态行，看是否有 `hls 致命错误` / `本机既跑不了 hls.js 也没有原生 HLS` 这类提示 —— 那才是设备能力上限。
3. 站点如果改了解密算法（换 key / 换 base64 层数 / 换原料名），我们的前端解密会失效。但 `phpsiteEc2` / `phpsitekey3` 这类命名带有站点习惯性，且原料内联在 HTML 里，一旦变化很容易从报错里发现。

---

## v1.4.3 — 2026-10-13 10:3x（播放页去广告 + 单列重排 + 红点心跳）

### 来源：用户第九轮反馈（v1.4.2 真机实测）
- 「进入到播放页面之后，就没有🔴红点了，没法往下滚动页面，看不到下面具体的播放页面的内容」
- 明确要求：「把页面里的广告都去掉，就剩下播放器和播放列表」

### 一、先定性（抓真实详情页 DOM，不猜）
用 `tools/probe_out/play_embed.html`（详情页 `shplay.php` 真实抓取）确认结构：
- 播放器：`#view_iframe.video-frame`（在 `.play-box-main` 内）
- 顶部广告块：`.anchor_banner > .banners_area` 里全是 `<a class="banner_" href=".../index/banner_click?id=...">` 的赌博/博彩外链（jusobook1.com、happytoto24.com、7st-333.com、dafs105.com、no1-789.com、neotvsports.com 等）
- 左侧栏 `.t-p-side` 内也塞了一排 `<a class="banner_">` 广告
- 播放器上方盖着广告 iframe `#adFrame`（`src="https://www.dodotv20.com/ad/index.html"`）
- 播放列表：`.play-box-side-main`（右侧栏，自带内部滚动 852>465）
- 播放器行下方还有「추천비디오」推荐区与翻页

「红点没了 + 没法滚动」的两个根因：
1. **广告 iframe 拖住 `onPageFinished`**：`#adFrame` 是外部跨域 iframe，加载卡住时主文档 `load` 事件迟迟不触发，红点注入被延迟，表现就是「进播放页红点没了」。
2. **嵌套布局使红点边缘滚动够不到真正滚动容器**：播放页是「播放器 + 右侧播放列表 + 下方推荐」的复杂布局，红点贴边滚动只滚得到局部容器，滚不出整页。

### 二、改了什么
| 改动 | 落点 | 为什么 |
|---|---|---|
| 新增 `ReplayCleanupScript`（注入脚本 **v2**） | `util/ReplayCleanupScript.kt` | 删掉 `#adFrame`、`.anchor_banner`、`.banners_area`、所有 `a.banner_`；仅详情页（存在 `.play-box`）隐藏左侧栏并重排成「播放器在上、播放列表+推荐在下」的单列整体可滚动布局；用 MutationObserver + 10 秒定时兜底清理延迟注入的广告；绝不碰 `__tvnav_dot`/`__tvnav_tip`。**v2 修掉一个致命死循环（见下方「二·补」）** |
| 广告资源网络层屏蔽 | `MainActivity.shouldInterceptRequest` 新增 `AD_RE` | 命中 `/ad/`、`banner_click`、`xiaoca.top/sj/` 等直接返回空响应——既去广告（与 DOM 清理双保险），又让 `#adFrame` 不再卡住 `load`、红点尽早出现 |
| 注入清理脚本 | `MainActivity.onPageStarted` + `onPageFinished` | 与红点/兜底脚本同期注入（两处互为备份） |
| 红点心跳 | `MainActivity.navHeartbeat`（回放模式每 1.2s） | 探 `window.__tvNav` / `window.__tvClean` 是否还在，丢了立刻补注入——直接治「进播放页红点没了」。脚本有版本短路由，已存在时补注入只是重绘、不扰操作 |
| 版本号 | `app/build.gradle` | versionCode 10→11、versionName 1.4.2→1.4.3 |

### 二·补：验证时揪出并修掉的【致命死循环】（注入脚本 v1 → v2）

写注入脚本时踩了个必须记录、也必须修的坑：

- `clean()` 每次都调用 `addStyle()`，而 `addStyle()` 对**已存在**的 `<style id="__tvclean_style">` 反复执行 `s.textContent = css`；
- 而 MutationObserver 是 `observe(document.documentElement, {childList:true, subtree:true})`；
- 给**已存在**节点重设 `textContent`，浏览器会「删掉旧文本节点 + 插入新文本节点」——正好是一次 `childList` 突变 ⇒ 触发 observer ⇒ 又调 `clean()` ⇒ 又重设 `textContent` ⇒ 再突变……**永不停歇的微任务循环，把网页 JS 主线程钉死。**

后果（已在无头 Chrome 上原样复现，非推测）：
- `Runtime.evaluate` 8 秒超时（验证脚本 [2]/[3] 步骤间歇性报 `eval 超时`）；
- 无头 Chrome 被钉在 **100% CPU**，一度把本机拖到接近死机；
- **若原样带上真机，进播放页会直接卡死 —— 比原来的「红点没了、滚不动」严重得多。**

**修复（v2）**：`addStyle()` 只在 `<style>` **首次创建**时赋 `textContent`；已存在就绝不碰它的内容。`clean()` 因此不再产生任何自触发突变，observer 只在「真有广告被删」时补跑一次并立刻收敛。

> 这正印证了「注入脚本是字符串、编译期查不出错」的风险：靠 `verify_cleanup.js` 的无头真跑才把它逼出来 —— 所以这一步验证不能省。

### 三、验证（无头 Chrome 真跑，非推断）
| 脚本 | 结果 |
|---|---|
| `verify_cleanup.js`（加载 `play_embed.html` 注入清理脚本后断言） | **13 / 0**：清理后 `.banner_`/`.anchor_banner`/`#adFrame` 全归 0；`#view_iframe` 与 `.play-box-side-main` 仍在；左侧栏 `display:none`；`document` 变为可整体滚动（`5414 > 449`）；动态追加的 `.banner_` 也被 `clean()` 清掉。脚本自带看门狗 + 信号处理 + 连树杀 Chrome，实测退出后残留进程为 0 |
| `verify_tvnav.js` | 115 / 0（红点逻辑未回退） |
| `verify_rescue_live.js` | 15 / 0（兜底播放未回退） |

APK：`tvlive-android-v1.4.3.apk`（versionCode 11）。已核对 dex 内含 `__tvClean`、`adFrame`、`anchor_banner`、`navHeartbeat` 等本轮新增符号。

### 四、仍然不确定的地方（如实说明）
1. **详情页重排后播放器高度用 `56.25vw` 估算 16:9**：在 16:9 电视上正好铺满；非常规比例屏会略有偏差，但播放器仍在、可看。
2. **左侧栏菜单在详情页被隐藏**：按用户「只留播放器+播放列表」的明确要求；分类浏览仍可用 App 原生左侧频道列表。若想保留站内菜单可再开。
3. 真机遥控器「红点移动手感、长按全屏触发」仍需真机最终确认；本次为代码层 + 无头浏览器层验证，未在本机模拟器实跑（环境无 hypervisor 驱动）。

---

## v1.4.4 — 2026-10-13 13:3x（回看页五处细节：红点更细 / 全屏后定位 / 停服页自愈 / 去屏上警告 / 返回逐步）

### 来源：用户第十轮反馈（v1.4.3 真机实测）
用户确认「**视频框显示问题（大问题）解决了！**应该是最终兜底的策略奏效了」，随后提了 5 个细节：
1. 回看页红点每次按键位移太大 → 有些按钮按不到，要更细；
2. 全屏后再回到下方播放列表选择时，红点定位不准（点这里却点到别处）；
3. 偶发整屏「工作空间已停止」错误页（截图3），问怎么办；
4. 网页上的警告信息去掉（红点的位置提示保留）；
5. 返回键要一步一步退回上一个画面，不要直接回直播；并修偶发的回看页错乱。

### 一、逐条定性 + 改动

**① 红点步长调细（`TvNavScript` v6→v7）**
`stepX/stepY` 由 `vw*0.08 / vh*0.09` 调细到 `vw*0.04 / vh*0.045`（1080p 约 86/97px → 43/49px），下限 48/36 → 24/20。
落点更细，控制条、列表项这类小目标不再被一步跨过。
**关键配套**：把「贴边滚动步长」独立出来（`scrollStepX/Y`，仍用旧的较大值）——
否则步长调细会让贴边翻页也变慢、按到手酸。**瞄准更细、翻页不慢**，两不耽误。

**② 全屏返回后定位不准**
根因：全屏切换改变 WebView 视口 → 页面重排（播放器 56.25vw、列表位置都变），
而网页自己的 `resize` 常在**重排完成前**触发 → 提示/命中测试读到旧布局 ⇒「看着点的是这里、实际点到别处」。
- 网页侧：`resize` 后延迟 320ms 再 `paint()` 一次（等布局稳定）；
- 原生侧：`applyFullscreen()` 后主动调 `__tvNav.repaint()`（新增 API：**原位重对齐、不挪回中心**），调两次 150ms / 500ms。

**③ 「工作空间已停止」占位页**
定性：**不是播放器问题**，是回放站或其宿主**云工作空间/沙箱**空闲被停后返回的占位页
（`工作空间已停止 / 错误码 12809 / SandboxId / TraceId / 立即启动 / 返回 Dashboard`）。
实测后端 `/api/config` 此刻返回正常 JSON ⇒ 属**间歇性休眠**。
- 网页侧：注入脚本检测该文案 → 上报 `stopped`，并顺手点「立即启动」按钮；
- 原生侧：`onHostStopped()` 自动重载唤醒，最多 3 次（防死循环）；正常页面 `caps` 上报时重置计数。

**④ 去掉网页上的警告信息**
`showDiag()` 不再把「⚠ …」写进状态行与回放提示条，只写 logcat（`tag=TvLive`）；
回放提示条固定显示静态操作说明。红点旁的「**位置提示**」（网页里 `__tvnav_tip`）**保留**（用户明确要求）。

**⑤ 返回键逐步返回 + 修回看页错乱**
根因：回放站「列表→播放」跳转多在**同源 iframe 内部**，顶层 WebView 历史不增长 ⇒
`canGoBack()` 恒 false ⇒ 旧逻辑**直接回直播**、退不回上一屏。
- 网页侧：维护「后退栈」（每次点击记录所在文档地址），暴露 `__tvNav.back()`，用 `report('nav','depth=N')` 上报深度；
- 原生侧：返回键若 `webNavDepth>0` 先调 `__tvNav.back()`，其次 `canGoBack()`，最后才回直播。
- 错乱的来源之一：新旧两套注入脚本同时在跑（各自响应方向键/resize）互相打架。
  新增 `dispose()`：注入新版本脚本前先清理旧实例的定时器与监听器。

### 二、验证（无头真跑 + 单测，非推断）
| 脚本 | 结果 |
|---|---|
| `verify_tvnav.js` | **128 / 0**（红点移动/点击/iframe 下钻/边缘滚动双向全绿；新增 10 项覆盖：步长、独立滚动步长、repaint、后退栈、dispose、停止页识别） |
| `verify_cleanup.js` | **13 / 0**（去广告 + 重排未回退） |
| `:app:testDebugUnitTest` | 通过，无回退 |

APK：`tvlive-android-v1.4.4.apk`（versionCode 12）。dex 已核对含
`scrollStepX`、`工作空间已停止`、`onHostStopped`、`repaintNavSoon`、`__tvNav.back`、`navStack`、`dispose`。

### 三、仍然不确定的地方（如实说明）
1. **「工作空间已停止」的宿主机归属**：截图顶部伴 `dodotv20.com` 字体 CORS 报错，且该站点/后端都可能跑在云工作空间上；
   无法 100% 断定是「回放站宿主」还是「我们的中继后端宿主」被停。故方案做成**不区分来源**：检测文案即唤醒重载，两者都能兜。
2. **后退栈的粒度**：以「点击前的文档地址」为单位，站点若用 `history.pushState` 在同一文档内切内容，后退栈感知不到（仍回退到上一次跨文档点击）。
3. 红点步长/滚动手感仍属主观项，需真机确认是否合适（可再微调 `0.04/0.045`）。

---

## v1.4.5 — 2026-11-12（修「网站/App 全打不开」：平台网关加 sharecode 校验，App 逐请求带码）

### 1) 故障与根因（实测定位，非猜测）
- 用户报告：网页端、移动端**全部打不开**。实测裸域名任意路径（含 `/api/health`）→ 平台网关返回 403
  「链接不完整：链接缺少必要信息，暂时无法访问」。
- 根因：托管平台对线上链接启用了 **sharecode 访问码校验**——每个请求必须带 `?sharecode=...`
  或携带首访带码时下发的 `__wb_rsc` cookie，否则直接被网关拦下（请求根本到不了我们的后端）。
- 影响链：浏览器用户访问旧裸链接被拦；App 的 OkHttp 请求（`/api/channels` 等）被拦；
  且播放链路的变体/分片 URL 是后端改写的**相对路径、不带码**，即便首请求过网关，后续请求仍 403。

### 2) 修复（两端同步改，版本 backend v0.3.28 / app v1.4.5）
- **后端 `server.js`**：新增 `SHARE_CODE` 常量；`/api/relay` 播放列表改写时给变体/分片/密钥 URI
  **全部追加 `&sharecode=...`**（播放器不管理 cookie，必须逐请求带码）；回放注入脚本 `PLAYER_PATCH`
  的 `fix()` 同样追加（模板串内用 `${SHARE_CODE}` 服务端插值——浏览器里没有该变量，不能写 `+ SHARE_CODE +`）。
- **安卓 `Backend.kt`**：新增 `SHARE_CODE` 与 `withSc()`，`channels/config/relay/embed` 四个构造器统一追加访问码。
- 实测确认 **sharecode 与应用绑定、重新部署不换码**（本次两次重部署码值不变 `CICKFPDYZQ`），硬编码安全；
  两处常量已加「若平台换码需同步改」的警示注释。

### 3) 顺带修复（本次单测暴露的历史欠账）
- `CoreLogicTest` 两个夹具一致性断言停留在旧状态（59 台 / 含 id163），而 v0.3.19–22 期间频道增删后从未更新，
  实为**改动前就已失败**的过时断言。已对齐 v0.3.28 现状：总 58 台、韩国 31 台新台号表、
  relay:false = [137,138,139,166,168,169,170,171]、走中继 50 台。

### 4) 验证
- 后端单测性质的全链路（Node 脚本，无 cookie 模拟 ExoPlayer）：
  master(带码) 200 → **改写变体 URL 已含 sharecode ✅** → 变体(无 cookie) 200 → 末段(无 cookie) 200 / 2.19MB 真实视频 ✅。
- 安卓纯 JVM 单测 16 项全部通过（含新增 `every_api_url_carries_gateway_share_code`）。
- 线上 `/api/health?sharecode=...` → `version: 0.3.28`，SBS 主台(140)/体育(167) token 自动刷新正常。

### 5) 使用变化（重要）
- 网页端必须用**带码链接**访问（首次带码后种 cookie，后续正常）：
  `https://tvlive-relay.app.workbuddy.host/?sharecode=CICKFPDYZQ`
- 安卓端需安装本版 v1.4.5 APK（旧版 App 的请求不带码，会被网关拦）。
- 用户在 App 设置里手输的自建局域网地址不受影响（网关校验只存在于托管平台的公网域名上）。

### 产物
- `tvlive-android-v1.4.5.apk`（工程根目录，6.49 MB）

---

## v1.3.0 — 2026-10-13 00:1x（回放页「看得见的诊断」+ 黑屏自愈）

### 来源：用户第六轮反馈（这次是提问）
原话：「问下，如果回看页面里具体视频没有播放按键出来，一直黑屏，但手机里是正常的话，怎么办」

### 一、先定性：这不是一个「猜得出来」的 bug，而是缺了「看得见」的能力
电视上黑屏、手机上正常 ⇒ 同一份代码、同一个页面，**差异只在设备环境**。
但在动手之前必须先承认一件事：**App 对网页里发生的一切原本是完全不知情的**——
没有接 `onConsoleMessage`，没有接 `onReceivedError`，没有处理渲染进程被回收。
结果是无论根因是什么，用户端看到的都只是「一块黑屏」，我们则连一句报错都拿不到。
这正是「**没有报错 ≠ 没有故障**」的典型场景，所以本次的第一优先级是**把原因带出来**。

### 二、先去线上做了实测（不猜）
用无头 Chrome 打开真实的 `/api/embed?url=<回放站>` 与播放页，记录下客观事实：

- 桌面 Chrome 里 `MediaSource` 存在、`canPlayType(m3u8)="maybe"` ——
  **但这两项在老电视盒子的 WebView 上完全可能是 no**，而那正是「播放器初始化失败、连按钮都没有」的成因；
- 回放站**播放页的地址有时效**（旧的 `shplay.php?id=...` 再打开会变成 `about:blank`）；
- 中继回源**间歇性失败**：同一脚本两次运行，一次列表页正常（271 个 div）、一次整页没加载出来。

### 三、改了什么

**A. 装上诊断（MainActivity）**
| 回调 | 抓什么 | 为什么是它 |
|---|---|---|
| `onConsoleMessage` | 网页 JS 的 ERROR + 注入脚本的上报 | 播放器初始化失败、解码不支持、跨域被拒，都表现为 JS 报错 |
| `onReceivedError`（旧签名） | 主文档加载失败 | 旧签名只在主文档出错时回调，天然过滤掉广告/统计脚本的噪音 |
| `onReceivedHttpError` | HTTP 403/404/5xx | 回放站的防盗链失败大多长这样 |
| `onRenderProcessGone` | 网页渲染进程被系统回收 | 老盒子内存紧张时极常见，现象**正是「突然全黑且不报错」** |

诊断会被**回显**到状态行与回放提示条（`⚠ 标签：内容`）——
电视上装不了开发者工具，用户拍一张照就能把根因带回来，比反复描述「就是黑屏」有用得多。

**B. 崩溃恢复**：`onRenderProcessGone` 里**必须返回 true**（返回 false 系统会连带杀掉整个应用），
并在原位销毁重建 WebView（`rebuildWebView()`）——已死的 WebView 重新加载或注入脚本都不会有任何反应。

**C. 注入脚本（TvNavScript v5）**
- `report()`：用 `console.log('__TVNAV__ ...')` 向原生层做单向上报（不必挂 JS 桥，老 WebView 也稳）；
- `caps()`：上报 `mse / nativeHls / mp4 / hlsLib` —— **一眼分辨「黑屏」是不是设备根本播不了**；
- `watchdog()`：注入后 20 秒内的自愈巡检，每件事只做一次 ——
  video 报错则上报 / 有 video 却没播则替用户 `play()` 一次 / 8 秒后仍无 video 元素则上报。
  刻意限制在 20 秒内且各自最多一次：之后用户多半已在正常操作，再干预就是添乱。

### 四、验证（全部实测，82 + 14 + 12 + 11 + 15 项）
- `verify_tvnav.js`：**82/82**。新增 [2b] 节核对 App 侧诊断能力（9 项）+ [3b] 节在无头 Chrome 里
  **真实接住 console 通道**验证诊断：实测收到 `__TVNAV__ caps mse=yes nativeHls=yes mp4=yes hlsLib=no`、
  造一个「存在但没在播」的 video 后 `__playCalled=true`（证明真的替用户按了播放）、
  把 `play()` 换成拒绝的桩后捕获到「自动播放被拒」上报、移除 video 并越过 8 秒阈值后收到「找不到 video 元素」上报。
- 回归：HLS 链路 14/14、后端链路 12/12、频道一致性 11/11、JVM 单测 15/15。
- 二进制核对：`versionCode=7 / versionName=1.3.0`；在 8 个 dex 中确认
  `__TVNAV__`×2、`watchOnce`、`WATCH_MS`×2、`rebuildWebView`×3、`onRenderProcessGone` 均已落地。

### 五、如实说明（本次**没有**解决的东西）
1. **本次不保证电视上就能出画面**。改的是「让原因可见 + 有限自愈」，不是「修好了黑屏」。
   如果根因是设备 WebView 缺 MSE / 解码能力不足，那是**设备能力上限**，代码层面无解
   （caps 上报会把这一条直接写在状态行上，届时即可确认）。
2. 真机遥控器与真机黑屏场景**仍无设备实测**——本机模拟器起不来（缺 hypervisor 驱动），这是长期盲区。
3. 中继回源间歇性失败是**服务端/网络侧**的现象，App 侧只能做到「失败时报出来」。

---

## v1.2.0 — 2026-10-12 23:4x（红点贴到屏幕边缘 → 朝该方向滚动页面）

### 来源：用户第五轮反馈
原话：「哦，对了，移动红点到屏幕边缘的时候需要向移动方向滚动窗口，我要看到相应的内容的」

### 一、先去线上真实站点摸滚动结构（不猜）
`tools/verify_scroll_live.js` 的前身探针实测（无头 Chrome 打开真实的
`/api/embed?url=<回放站>`，1920×1080）：

| 页面 | 根滚动器 | window.scrollBy | 内部可滚容器 |
|---|---|---|---|
| 回放站·列表页 | `<html>`（overflow-y:auto） | 有效 | **无** |
| 回放站·播放页 | `<html>`（overflow-y:auto） | 有效 | **有 1 个**：`.play-box-side-main`（scrollHeight 852 / clientHeight 465） |

结论：**主路径是滚根元素**，但播放页存在「内部滚动容器」，所以滚动必须做成
**由内到外的接力**（先滚内部容器，滚到头再滚整页），否则播放页那个列表后面的条目永远看不到。

### 二、上一版的问题（为什么这件事没真正生效）
旧实现在 `move()` 里只有一句：
`if (nx > vw() - HIT_EDGE && tryScroll(dx, 0)) nx = cx;`，其中 `HIT_EDGE = 6`。
两个毛病：
1. **判定带只有 6px**：红点要贴到离边缘 6px 才触发滚动，而红点半径就有 9px
   —— 贴到那个位置红点已经被屏幕切掉一半，用户几乎看不见自己在哪。
2. **`tryScroll` 只认 `document.scrollingElement` + `window.scrollBy`**：
   `scrollingElement` 是 Chrome 51 之后才有的属性，**老旧电视盒子上的老 WebView 根本没有**；
   怪异模式（老站常见）下滚的是 `<body>` 而不是 `<html>`。
   两种情况都会让「滚没滚」判断为 false → 红点只是静静贴到边上，**什么都不滚**
   —— 现象正是用户说的「没反应」。

### 三、改法（`util/TvNavScript.kt`，脚本版本 3 → 4）
- 新增两个常量，替代原来单一的 `HIT_EDGE`：
  - `BAND = 36`：**贴边判定带**。红点进入距边缘 36px 内、再朝该方向按键 → 改为滚页面。
    留这 36px 是为了让红点始终完整可见（不会被切掉一半，能瞄）。
  - `HARD = 8`：**硬边界**。页面在该方向已经滚到头时，允许红点继续贴到距边缘 8px，
    否则最右/最下 36px 内的内容永远点不到。
- `move()` 改成「贴边带内 → 先试滚动；滚成功则红点留在原地（内容从它下面滑过），
  滚不动才走到夹取逻辑贴到 HARD」。滚动量取本次按键步长，按一次 = 内容平移一格，手感连续。
- `tryScroll()` 重写为**四级接力**：
  1. 红点正下方元素 → 逐级向上找可滚祖先（同源 iframe 内会自动从内层文档开始）；
  2. 红点所在文档的根滚动器；
  3. 顶层文档根滚动器 + `window.scrollBy`；
  4. 兜底：几何扫描（`scanScrollable`，找出矩形覆盖红点位置的可滚容器）。
- 新增 `canScroll()` / `scrollNode()` / `scrollDocRoot()` 三个小函数：
  - `scrollDocRoot` **同时尝试 `scrollingElement` / `documentElement` / `body` 三个候选**
    —— 正是为了覆盖「老 WebView 没有 scrollingElement」「怪异模式滚 body」这两种静默失效场景；
  - `scanScrollable` 先做便宜的尺寸判断（scrollHeight/clientHeight），只有内容确实超出的元素
    才去读 `getComputedStyle`（读样式很贵，电视盒子 CPU 弱）。
- 回放提示条文案补上「（贴边滚动）」，让用户知道红点贴边是有用的。

### 四、验证（全部实测）
- `tools/verify_tvnav.js` 新增整节 **[4] 边缘滚动**，无头 Chrome 真实注入 + 真实按键，**61/61 通过**：
  贴边后继续按下 → 页面滚动；再按 6 次仍在继续滚（不是只滚一次）；
  贴到上边缘按上 → 滚回顶部（双向都通）；页面不能横滚时红点能贴到距边 8px；
  红点始终留在视口内；**内部容器优先滚动且整页不动**；
  **内部容器滚到底后自动接力滚整页**；横向可滚容器也能被滚（scrollLeft 2525）。
- `tools/verify_scroll_live.js`（**新增**）：拿**线上真实回放站**再验一遍，**10/10 通过**：
  列表页 scrollTop 0 → 924；播放页 0 → 504；两边贴到上边缘按上都能回到 0；
  滚动后命中测试仍返回真实网页元素。
  （第一次跑曾误报 1 项失败 —— 是探针本身等页面加载的时间不够、`document.body` 还是空的，
   已改成轮询「body 存在且可滚高度 > 200」再开测。）
- Gradle 构建成功，JVM 单测 15/15；HLS 链路 14/14、后端链路 12/12 回归通过。

---

## v1.1.1 — 2026-10-12 23:2x（韩国台与网页版对齐：尊重后端 relay 标记）

### 来源：用户第四轮反馈
原话：「然后再对比一下韩国电视台的具体情况，跟网页版比起来好像少了几个，
除了没有验证过的 KBS/SBS/JTBC 等主流地面台，其他台尽量跟网页版保持一致」

### 一、先把「到底差在哪」查清楚（实测，不是推测）
- **网页版与 App 拉的是同一个接口**：`/api/channels`。实测线上响应 = **59 台**，
  分组为 韩国 31 / 测试 1 / 音乐 3 / 纪录片 5 / 体育 3 / 电影 10 / 新闻 6。
- **App 端没有内置韩国清单、也没有任何过滤**：`ChannelRepo.parseChannels` 只丢弃 `url` 为空的条目
  （线上没有这种条目），`applyFilter` 按 `group` 全等筛选 —— 与网页版 `app.js` 的 `renderList()` 完全同规则。
  ⇒ **两端的韩国台都是 31 个，逐条同号同名。**
- **唯一真正的差异在「怎么播」**：网页版 `app.js` 写的是
  `const useRelay = relayOn && ch.relay !== false;` —— 它会按后端 `relay` 标记决定
  「走中继」还是「**本机直连**」；
  而 **App 此前完全忽略该字段**，一律拼 `/api/relay`。
  线上被标 `relay:false` 的 6 个台里，**5 个正是用户点名的韩国地面波主台**：
  `137 KBS 1TV`、`138 KBS 2TV`、`139 JTBC`、`140 SBS`、`141 MBC`（另一个是 `163 凤凰卫视中文台`）。
  这些源连部署在上海的中继都够不到（地域封锁），只有播放端本机直连才有机会
  —— 所以它们在 App 上「明明在列表里，一点就报错」，看起来就像「少了几个台」。

### 二、修复（就是把网页版那条规则原样搬过来）
- `data/Channel.kt`：新增 `relay: Boolean = true` 字段（**默认 true**，语义与网页版一致：
  字段缺失时仍走中继，不会因为缺字段就误改直连）。
- `data/ChannelRepo.kt`：`parseChannels` 增加 `relay = o.optBoolean("relay", true)`。
- `data/Backend.kt`：新增纯字符串函数
  `playUrl(base, rawUrl, relay)` = `relay ? 中继地址 : 源地址`，
  以及 `relayLabel(relay)`（"经中继" / "本机直连"）。
  写成纯函数是为了能被**纯 JVM 单测**覆盖，不必依赖设备。
- `ui/MainActivity.kt`：`playLive()` 改用 `Backend.playUrl(...)`，
  并在状态行标出播放方式：`正在播放：XXX（本机直连）`。
  用户因此能一眼看出「这台是中继还是直连」，直连失败时也知道该怪谁。
  （清单本就未被限制，加这个标注是为了让「到底走了哪条路」可见。）

### 三、顺手补上「数量可见」（针对「好像少了几个」这个疑虑）
`applyFilter()` 现在把当前分组台数写进状态行：
- 选中「全部」→ `共 59 台（来源：后端）`
- 选中某分组 → `分组「韩国」共 31 台`

理由：网页版的分类头上有数量，电视端没有 → 用户无从核对，容易怀疑缺台。
不新增控件、不动布局，只改状态行文案（避免无谓的 UI 变动）。

### 四、验证（凡能自动查证的全部实测）
1. **新增 `tools/verify_channel_parity.js`（11/11 通过）**：
   拉线上 `/api/channels`，分别按「网页版规则」与「App 规则」各算一遍清单并逐条比对
   （总数、台号、名称、顺序全等），打印韩国组详表与 relay 状态，
   并与工程内归档夹具比对以发现线上漂移。
2. **单元测试新增 6 个用例**（共 15 个，全绿），其中两个是**用线上真实响应做夹具**的：
   - `app_sees_same_korean_channels_as_web`：夹具即线上原样响应，用 **App 自己的解析代码**跑出
     59 台 / 韩国 31 台，并把 31 个台号序列**钉死**，以后任一端增删都会被立刻发现；
   - `unverified_korean_main_stations_are_marked_direct_connect`：断言 `relay:false` 恰为
     `[137,138,139,140,141,163]`、其余 53 台走中继（防止「默认值被改错」这类回归）；
   - 另有 `playUrl` 两条（relay true/false 分别产出中继地址/源地址）、`relayLabel`、`relay` 解析。
   - 夹具文件：`app/src/test/resources/channels_live.json`（线上原样，14.5KB）。
3. 编译 `BUILD SUCCESSFUL` + aapt2 核对产物版本号。

### 五、诚实边界
- 本次**没有新增韩台**：线上韩国组本就是 31 个，网页版也是 31 个，两端逐条一致（已实测）。
  用户感觉「少」的那部分，经查是**播放路径差异**（本机直连标记被忽略），已修复。
- `relay:false` 的 5 个韩国主台本身就是「未经验证、碰运气」的源（HISTORY 早有标注），
  改成直连只是**把网页版给过的机会同样给到 App**，不保证能播；能否出画面取决于你的家宽线路。
- 若用户看到的台数与 31 不符，是数据之外的另一个问题（如后端地址被改、后端不可达回退到 2 台兜底），
  需要按设备上的状态行文案定位。

---

## v1.1.0 — 2026-10-12 23:1x（控制条只留全屏 + 回放页改「红点鼠标」光标）

### 来源：用户第三轮反馈（v1.0.2 实测）
原话两点：
1. 「有全屏模式了，且功能好用，它旁边的什么静音、暂停就不要了，就留一个全屏/退出全屏 就够了」
2. 「现在回放页面里是通过选框来做的，改成一个红点🔴，让我用遥控器来控制，当成类似鼠标的功能，
   按遥控器中间确定键就是按下去的操作，这样即使换了别的网站也能操作」

### 改动一：直播控制条精简为只剩「全屏 / 退出全屏」

按用户要求删掉「播放/暂停」「静音」两个按钮，涉及三处（都改干净，不留死代码）：
- 两套布局（`layout/`、`layout-land/`）删掉 `btn_ctrl_play` / `btn_ctrl_mute` 两个控件；
- `MainActivity` 删掉 `btnCtrlPlay` / `btnCtrlMute` 引用、`muted` 静音状态、
  以及只服务于这两个按钮的 `syncControlLabels()` 分支；
- 播放器监听 `onIsPlayingChanged`（原本只为同步「暂停/播放」文字）一并移除。

`updateControlsForMode()` 随之从「按模式隐藏按钮」退化为「只控制回放提示条显隐」——
全屏按钮在直播、回放两种模式下**都有意义**（都是把左侧列表收掉、让画面/网页铺满屏幕）。

### 改动二：回放页导航从「选框跳元素」改成「红点鼠标」

上一版把页面上所有可交互元素枚举出来，方向键在元素之间跳、红框框住当前元素。实测的
三个硬伤（正是用户要换掉的动机）：
- 只能点到「被我们判定为可交互」的元素，判定不到的地方就是盲区；
- 换个网站 DOM 结构不同（很多按钮是 div 且不带 onclick）就可能完全不灵；
- 与「指针」的直觉不一致 —— 用户想要的就是一个能自己控制的红点。

**新方案（鼠标隐喻）**：`util/TvNavScript.kt` 整个重写（脚本版本 2 → 3）
- 屏幕出现一个圆形红点 🔴（`position:fixed` + 最大 z-index，`pointer-events:none`
  —— 最后这条是命门：红点若自己吃事件，命中测试永远只能点到它自己）；
- 方向键按**固定步长**挪动红点（步长按视口比例给：`max(48, vw*8%)` / `max(36, vh*9%)`），
  手感与分辨率/密度无关；红点被夹在视口内、不会跑出屏幕；
- 按确定 → 用浏览器原生的 `document.elementFromPoint(x, y)` 做命中测试，
  再补一套完整鼠标事件（`mousemove/mouseover/mousedown/mouseup`）后调用
  **原生 `click()`** —— 只有原生 click 才会触发链接跳转、表单提交这些默认行为
  （合成事件 `isTrusted=false` 不触发默认行为）；
- **移上去就补悬停事件**：大量播放器只在鼠标悬停时才显示控制条，不补的话用户会遇到
  「明明点到了、按钮却根本不存在」；
- 红点下方跟一个小提示条，显示目标元素的文字（如「图片：海报」/「输入框：搜索」），
  电视上没有鼠标指针形状可看，这个提示就是唯一的「我这一下会点到什么」；
- 红点顶到视口边缘后**改为滚动页面**：先滚 window，滚不动再从红点下的元素往上找
  可滚动的祖先容器来滚（不少站点把内容放在自绘滚动容器里）。

### 改动三（配套，非用户直接要求但必须做）：长按确定键 = 切全屏

方向键被网页接管后，**遥控器无法再把焦点移到画面上那个「全屏」按钮上** ——
这是上面的鼠标方案带来的新问题（不改的话全屏在回放页就成了死功能）。
解决：`dispatchKeyEvent` 里把确定键拆成两种行为
- **短按 = 点击**（在红点位置按下鼠标）；
- **长按 700ms = 切换全屏 / 退出全屏**（每台遥控器都有确定键，不依赖菜单键）；
- 「菜单」键同样可以切全屏，照顾带菜单键的遥控器。

阈值取 700ms（比系统默认 500ms 略长）：回放页需要频繁点按，阈值太短会把
「手慢一点的单击」误判成长按，变成莫名其妙切全屏。

### 改动四（配套）：回放模式按「返回」先让网页后退

红点能点进「列表页 → 播放页」之后，必须能退回来：否则用户会被困在播放页，
退回直播再点「回放」还是那一页（WebView 没有重载）。
现在的顺序：**能退网页就先退网页 → 退到网页第一页才回到直播**（与浏览器直觉一致）。
提示条文案同步改为「🔴 方向键移红点 · 确定=点击 · 长按确定=全屏 · 返回=后退/回直播」。

### 线上页面实测（这次是先去看了真实站点，不是照猜）

拿后端的内嵌代理抓了真实回放站的页面来做设计依据：
- **列表页**（`show.php?tid=3`）：视频卡片就是 `<a href="/api/embed?url=...shplay.php?id=...">`，
  同源相对地址 → 红点原生 click 直接就能跳转进播放页；
- **播放页**（`shplay.php?id=...`）：结构是「上广告 iframe + 下播放器 iframe」，其中
  - 广告 iframe 是**跨域**的（`https://www.dodotv20.com/ad/index.html`）——
    红点点不进去（同源策略，无解），但该页自带 6 秒倒计时
    （`countdown = 6` → `showVideo()` → `adFrame.style.display='none'`），**会自动消失**，不需要用户操作；
  - 播放器 iframe 的 src 是后端改写的**同源相对地址**（`/api/embed?url=https://xiaoca.top/...m3u8`）
    → **红点可以钻进去**。
- 因此新增「同源 iframe 下钻」：命中测试遇到 iframe 就取 `contentDocument` 继续往里找，
  点击与悬停都作用到最内层元素；跨域 iframe 拿不到 `contentDocument`，自然停在外层。
- 另外新增「钻进同源 iframe 找 video」：初始落点若在顶层找不到视频，就逐层钻进同源 iframe 找，
  找到就把红点直接放到视频中心 —— 真实回放站的播放器正是在同源 iframe 里。

### 验证（交付前实测，非推断）
- 编译通过（`BUILD SUCCESSFUL`）；单元测试 **9/9**
- `tools/verify_tvnav.js` 重写并 **48/48 通过**：
  - 语法校验 + 静态自检（红点样式、`pointer-events:none`、`elementFromPoint`、原生 `click()`、
    四类鼠标事件、iframe 下钻、边缘滚动）；
  - **无头 Chrome 真实注入 + 真实按键**：红点是 18px 圆形纯红（实测 `border-radius:50%`、
    `rgb(255,59,48)`、`z-index:2147483647`、`pointer-events:none`）；初始落点 = 视口正中；
    该点 `elementFromPoint` 命中的是页面元素而**不是红点**（证明红点不挡命中）；
    按右/下各移动恰好一个步长；连按走到右侧按钮上、**按确定真的点中（页面回执 `RIGHT`）**；
    移到 hoverbox 上时 `mouseover/mousemove` 计数 +1（悬停补发有效）且能被点中；
    **同源 iframe 内部的按钮也被点中（iframe 回执 true）**；
    **视频藏在同源 iframe 内时红点能钻进去落到视频中心**；重复注入不产生第二个红点；
    顶到边缘后继续按方向键 → `scrollY=896`（确实滚动了页面）；
  - 核对 Kotlin/布局侧真的精简了：两套布局只剩 `btn_ctrl_full`，`MainActivity` 里
    `btnCtrlPlay`/`btnCtrlMute`/`muted` 全部消失，长按确定与菜单键切全屏都在。
- 回归：`tools/verify_backend_endpoints.js` **12/12 通过**（后端接口 + 中继 + 回放代理 + 真实 TS 分片）
- `aapt2` 核对编译产物：`versionCode=4 / versionName=1.1.0`；资源表里只有 `id/btn_ctrl_full`
  与 `id/live_controls`，**`btn_ctrl_play` / `btn_ctrl_mute` 已完全不存在**（不是被隐藏，是没有了）；
  两套布局的 `focusableInTouchMode` 由 9 处降为 **7 处**（正好少了两个被删的按钮）。

### 仍未验证（如实说明）
遥控器在**真机上**的实际手感（红点移动速度是否顺手、长按 700ms 是否好触发）**没有设备实测数据** ——
本机模拟器起不来（缺 hypervisor 驱动），这是唯一未覆盖的盲区，需用户在电视上实测后反馈。

---

## v1.0.2 — 2026-10-12 22:2x（直播页全屏按钮 + 回放页遥控器光标 + 统一焦点细框）

### 来源：用户第二轮机顶盒/电视实拍截图（v1.0.1 实测）
反馈三点：
1. 直播页**没有全屏按钮**，画面下方像是「被去掉了」
2. 回放页里遥控器**完全没有移动的感觉**，不知道选的是哪个、也点不到播放按钮
3. 直播页当前选中项希望用**细框**标出来，好一眼看到光标在哪

### 问题一：找不到全屏按钮 —— 真因是「Media3 内置控制器本来就没有这个按钮」

用户截图里，画面右下角只剩孤零零一个「速度」按钮。查证结果：
- Media3 的 `PlayerView` **内置没有全屏按钮**（1.2.0 版确实没有），必须自己实现；
- 直播流不可拖动（live），控制器会自动隐藏进度条与时长，于是只剩「速度」一项 ——
  这正是用户看到的「下面被去掉了」；
- 它的按钮在触摸模式下也无法被遥控器聚焦（与 v1.0.1 同一个机制）。

**修复**：
- 用 `app:use_controller="false"` 关掉内置控制器，避免两套控件相互打架；
- 画面上叠一条自绘控制条 `live_controls`：**播放/暂停 · 静音 · 全屏**，
  三个按钮都声明 `focusableInTouchMode`，遥控器能选中、聚焦时显示细边框；
- 全屏实现 `applyFullscreen()`：隐藏左侧频道列表 + 隐藏播放页顶栏 + 隐藏系统状态栏/导航栏
  （沉浸式）；按「返回」可退出全屏；`onResume` 时重新应用，防止从后台回来系统栏复现；
- 焦点连线：列表项按「右」进入控制条，控制条按「上」/「左」回到列表 ——
  不做这条连线的话，「全屏」按钮在电视上根本走不到，等于摆设。

### 问题二：回放页遥控器毫无反应 —— 真因是「WebView 没有内建空间导航」

网页里的元素不会响应方向键。Android WebView 不提供「方向键在网页元素之间移动」的能力
（Chromium 的空间导航默认关闭，且没有公开开关）。

**修复**：新增 `util/TvNavScript.kt`，在页面加载完成后注入一段光标导航脚本：
- 收集页面上所有可交互元素（链接 / 按钮 / 输入框 / 视频 / 带 onclick 的节点）；
- 方向键 → 用几何算法找该方向上最近的元素，移动一个**红色高亮框**（脚本自绘，
  不依赖页面样式，因此任何站点都能显示）；同时显示「第 n / 共 m 个」序号标签，
  并自动把当前元素滚进可视区域；
- 按「OK / 确定」→ 对当前元素派发真实点击，并补发合成鼠标事件提高兼容性；
- `MutationObserver` 监听页面变化后自动重扫（搜索、翻页、加载更多之后光标不会停在空处）。

`MainActivity.dispatchKeyEvent` 在回放模式下把 D-pad 按键**原样转发**给该脚本；
界面上加提示条「方向键移动光标 · 按「OK/确定」选中 · 按「返回」回到直播」，
并在回放模式收起无效的「播放 / 静音」按钮。

**已知边界（不回避）**：脚本只能作用于**顶层文档**。若播放按钮位于**跨域 iframe 内部**，
受浏览器同源策略限制无法控制。用户截图里那个播放按钮位于顶层文档，可以覆盖。

### 问题三：焦点看不清 —— 新增统一细边框

原先只有底色变化（灰底 / 红底），在电视上不够显眼。新增统一绘制函数 `paintFocus()`：
底色 + 聚焦时叠一层 **2dp 白色描边**（选白色是因为它在任何底色上都看得见，
包括红底的「已选中」状态 —— 用红框叠红底会糊成一片）。
应用于 tab、分组按钮、顶栏按钮、控制条按钮；频道列表项在 `bg_item_channel.xml`
里同步改为 2dp 白色描边 + 4dp 圆角。

### 验证（交付前实测，非推断）
- 编译通过；单元测试 **9/9**
- 新增 `tools/verify_tvnav.js`：**14/14 通过**
  - 先从 Kotlin 源码里把注入脚本抠出来做**语法校验**（这类错误编译期查不出，
    只会在真机上表现为「没反应」，极难定位，必须先挡住）；
  - 再用无头 Chrome 造一个模拟回放站页面（顶部搜索框 + 左侧三个链接 + 一个红色播放按钮），
    **真实注入 + 真实派发按键**：
    初始光标即落在「播放按钮」上（而不是搜索框）；从播放按钮连续按「上」，
    依次经过 `a3 → a2 → a1 → search`（**同列优先，不跨列跳跃**）；
    序号标签同步为 `n / 5`；**按确定键真的点中了播放按钮（页面回执 `PLAY-CLICKED`）**；
    重复注入不会产生第二个高亮框。
  - 这套验证当场抓出并修掉了两个真问题（自测发现，不是等用户踩）：
    ① 初始落点原本按「面积最大」选，结果选中了 300×34 的搜索框而不是播放按钮
       → 改为「离视口中心最近」；
    ② 导航原本只比中心点，导致「按上从播放按钮直接跳到左上角搜索框、跨过中间三个链接」
       → 改为标准的**区间重叠**判据（另一轴有重叠即视为「同列 / 同行」，优先）。
- aapt2 核对编译产物（竖屏与横屏两套布局一致）：
  - `player_topbar` / `live_controls` / `btn_ctrl_play` / `btn_ctrl_mute` / `btn_ctrl_full` /
    `tv_replay_hint` 全部存在；
  - `use_controller=false` 已生效；
  - `focusableInTouchMode=true` 共 **9 处**（原 6 处 + 新增 3 个控制条按钮）；
  - 列表项聚焦描边编译结果为 `width=2.0dp` / `color=#ffffffff`。

### 仍未验证（如实说明）
遥控器在**真机上**的实际手感（焦点走向、全屏切换后的画面表现）**没有设备实测数据** ——
本机模拟器仍起不来（缺 hypervisor 驱动）。必须由用户在电视上实测确认。

---

## v1.0.1 — 2026-10-12 22:0x（修复真机暴露的三个问题）

### 来源：用户在小米电视上的实拍截图（v1.0.0 首装实测）
反馈三点：
1. 顶部「直播 / 回放」两个标签，遥控器**选不到**
2. 分组筛选条（全部/体育/新闻/测试/电影…），遥控器**选不到**
3. 播放报错 `ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED`

### 问题一、二的真因：触摸模式下的可聚焦性

对比代码发现唯一差别：
| 控件 | 声明 | 遥控器能否选中 |
|---|---|---|
| 频道列表项（`item_channel.xml`） | `focusable` + **`focusableInTouchMode`** | ✅ 能（截图里能看到红框） |
| 直播/回放标签、分组按钮、顶栏按钮 | **只有** `focusable` | ❌ 完全选不到 |

**结论**：这台小米电视的应用窗口运行在**触摸模式**下。此时 Android 只允许
`isFocusableInTouchMode == true` 的控件获得焦点；仅声明 `focusable` 会被焦点搜索整段跳过。
所以从列表项按「上」时，分组按钮被跳过 → 标签被跳过 → 顶栏按钮被跳过 → 焦点原地不动。

**修复**：
- 两套布局（`layout/`、`layout-land/`）里 6 个可聚焦控件的 `focusableInTouchMode` 全部补齐（XML）
- 运行时动态创建的分组按钮同样补 `isFocusableInTouchMode = true`（代码）
- WebView 也显式设为可聚焦，否则遥控器「走不进」回放网页

### 问题三的真因：中继地址丢了 `.m3u8` 后缀 → 播放器选错解析器

`media3` 的 `DefaultMediaSourceFactory` 判断容器类型时看的是**地址路径末段后缀**，
而中继地址长这样：

```
https://后端/api/relay?url=http%3A%2F%2Fonair.cdn.tvchosun.com%2F...%2Fplaylist.m3u8
                                    └─ 路径末段其实是 "relay"，压根没有 .m3u8
```

于是它按**普通 MP4** 处理，把 m3u8 纯文本当视频容器解析 → `ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED`。
（与网页版当初踩的 Artplayer「靠后缀选 HLS 处理器」是同一类坑。）

**修复**：新增 `MimeHint.of(源地址)` 推断 MIME，`LivePlayer.play(url, mimeType)` 用
`MediaItem.Builder().setMimeType(...)` 显式声明 `application/x-mpegURL`。
注意必须拿**源地址**推断 —— 中继地址后缀已经不可信。

### 顺带修掉的电视端体验问题（同一批改动内）
1. **切换分组会丢焦点**：原先每次点分组都 `removeAllViews()` 重建按钮，焦点随之丢失。
   改为**只刷新样式不重建视图**，并在列表刷新后把焦点恢复到刚点的按钮上。
2. **焦点不可见**：原先只有「选中」态有红底，光标移到未选中项上完全看不出来。
   新增焦点反馈：当前模式/分组 → 红底白字；仅聚焦 → 灰底白字；普通 → 透明底灰字。
3. **光标与画面不是同一台**：启动自动播放上次频道后，焦点却停在列表第一行。
   改为把焦点落到「正在播放的那一行」（先滚动到可见再请求焦点，取不到视图则退回列表）。
4. **遥控器进了回放网页后无路可退**：电视端在回放模式下按「返回」原先会直接退出应用。
   改为「返回」= 退回直播并把焦点收回列表；状态行也提示「按「返回」可回到直播」。
5. **列表项星标抢焦点**：星标原为可聚焦，按「右」会掉进星标那一列，上下移动只能沿星标走。
   改为星标不参与焦点导航（`focusable=false`，鼠标/触摸点击仍可用），
   电视上改成**长按整行**切换收藏。
6. **方向键连线**：补上静态的 `nextFocusUp/Down`（顶栏按钮 ↔ 标签行），
   动态的分组按钮 ↔ 列表在代码里按实际 id 连线，保证上下贯通不依赖几何猜测。

### 验证（可自动查证的部分，全部实测）

**1) 编译 + 单元测试**
- `BUILD SUCCESSFUL`，`9/9 单测通过，0 失败 0 错误`
- 新增 2 个用例专测本次修复的核心逻辑：
  - `m3u8_source_is_reported_as_hls`：`playlist.m3u8` / 带 `?t=` 参数 / 大写 `.M3U8` 都判为 HLS
  - `non_hls_source_returns_null_so_player_sniffs_itself`：MP4 与空串返回 null

**2) APK 静态验证（aapt2 dump xmltree，编译后的二进制布局）**
- `versionCode=2  versionName=1.0.1`
- `tab_live` / `tab_replay`：`focusable=true` + `focusableInTouchMode=true` + `nextFocusUp=btn_backend` ✅
- `btn_backend`：`focusable` + `focusableInTouchMode` + `nextFocusDown=tab_live` ✅
- `btn_player_back` / `btn_fav` / `btn_reload`：均已补 `focusableInTouchMode` ✅
- 竖屏布局同样 6 个控件补齐 ✅
- 列表项根：`focusable` + `focusableInTouchMode` + `clickable` ✅；星标：`focusable=false` ✅

**3) HLS 全链路验证（`tools/verify_hls_chain.js`，新增，复刻 ExoPlayer 的取流与地址解析规则）**
- `14 项全部通过，0 失败`
- 链路：`/api/channels` 59 台 → 中继 master(`#EXTM3U`) → 子清单 `chunklist.m3u8`(200)
  → **真实分片 3/3 全为 TS 容器**（5.8MB / 4.3MB / 5.5MB）
- 关键对照（把病根钉死）：
  - 源地址路径末段 = `playlist.m3u8` → 可判定 HLS
  - 中继地址路径末段 = `relay` → **无法靠后缀判断**，故必须显式传 MIME

**4) 宿主端链路回归**（`tools/verify_backend_endpoints.js`）
- 12 项全部通过（频道/配置/中继/分片/回放页接管），未受本次改动影响

### 仍未验证（如实说明）
- **遥控器实际操作手感**：焦点链路的代码依据来自 Android 焦点机制 + 编译产物核对，
  但「按上/下/左/右光标实际怎么走、按下中间键是否切台」**没有设备实测数据**
  （模拟器仍受限于本机未装 hypervisor 驱动；详见 v1.0.0 记录）。
- **播放能否真正出画面**：已证明「链路通 + 分片是真实 TS + MIME 已显式声明」，
  但最终出画仍需真机确认。
- 电视端 WebView 版本差异导致的回放表现差异。

### 产物
- `tvlive-android-v1.0.1.apk`（工程根目录，6.4 MB）
- 新增验证脚本：`tools/verify_hls_chain.js`

---

## v1.0.0 — 2026-10-12 20:5x（首个可安装版本）

### 背景
此前只有网页版（`re-soft/tv-iptv`，后端 v0.3.13）。本版将其做成安卓 App，
要求在**手机和电视**上都能使用。

### 从零新建独立工程
- 新目录：`re-soft/tvlive-android/`
- 与 E 盘 `doubao_work/TVBox` 工程**完全隔离**：
  - 不同工程目录、不同包名（本工程 `com.leo.tvlive` vs 对方 `com.your.tvbox`）
  - **未读写、未改动 E 盘任何文件**（仅复制了一份 Gradle 发行版到本工程 `tools/`）
  - 两个 App 可在同一台设备上并存，便于横向对比
- Gradle 发行版（8.2）随工程携带在 `tools/gradle-8.2`，不依赖别处的全局安装

### 功能
1. **直播**：拉取后端 `/api/channels`（59 台），播放地址统一走 `/api/relay` 中继
2. **回放**：WebView 打开 `/api/embed?url=<回放站>`，复用网页版已实测可播的内嵌代理 + 播放器注入方案
3. **双形态 UI**：手机「列表 ⇄ 全屏播放」两级页面；电视「左列表 + 右播放」常驻同屏
4. **收藏**：本地持久化，列表内可切换
5. **分组筛选**：按后端 group 过滤（韩国/电影/新闻/纪录片/体育/音乐/测试）
6. **后端地址可改**：界面内修改，不用重装；回放地址由后端 `/api/config` 下发，服务端改完即生效

### 关键设计取舍（为什么这样做）
- **直播必须走中继**：频道源存在地域封锁与 Referer 校验，直连大概率失败；
  网页版之所以能播正是因为所有流请求都走服务端中继。App 沿用同一路径。
- **回放用 WebView 而非原生实现**：回放可用性取决于「服务端补 Referer + 注入播放器补丁」这一整套，
  该逻辑在网页版已实现并实测通过。在 App 内原生重写（解 base64→XOR→base64 + 中转）工作量数倍且风险高，
  首版直接复用网页方案，等于白捡。
- **编码用纯 JDK 的 URLEncoder**（而非 Android 的 `Uri.encode`）：
  这样核心 URL 构造逻辑可在**纯 JVM 单元测试**中直接验证，无需模拟器/真机。

### 构建环境（实测）
| 项 | 实际值 |
|---|---|
| JDK | 21（Android Studio 自带 jbr） |
| Gradle | 8.2（随工程携带） |
| AGP / Kotlin | 8.2.0 / 1.9.0 |
| compileSdk / minSdk / targetSdk | 34 / 21 / 34 |

注意：Gradle 8.2 官方兼容表未列 JDK 21，本机**实测可正常构建**（`gradle --version` 显示 `JVM: 21.0.3`，构建 BUILD SUCCESSFUL）。

### 构建过程中修掉的问题
1. `DefaultMediaSourceFactory` 的包路径写错（应在 `androidx.media3.exoplayer.source` 下）→ 编译报 Unresolved reference，已修正。
2. `Backend` 里曾写下不存在的接口路径 `/api/player`（后端真实路径是 `/api/relay`）→ 已删除，避免留假接口。
3. 首版验证脚本断言过死（要求「全部为 .m3u8」）→ 后端里 `测试 · Big Buck Bunny (MP4)` 是合法的渐进式媒体源，
   已把断言改为「HLS 或渐进式媒体」。

### 验证（可自动查证的部分，全部实测）
**1) APK 静态结构**（aapt2 dump）
- 包名 `com.leo.tvlive`、versionName `1.0.0`
- minSdk 21 / targetSdk 34
- 权限：INTERNET / ACCESS_NETWORK_STATE / WAKE_LOCK（无多余权限）
- `android.software.leanback` 与 `android.hardware.touchscreen` 均 `required=false`
- MainActivity 同时声明 `LAUNCHER` 与 `LEANBACK_LAUNCHER` 双入口

**2) 单元测试**（`tools/` + `app/src/test/`，纯 JVM）
- `7/7 通过，0 失败 0 错误`
- 覆盖：中继 URL 完整编码、后端地址尾斜杠规范化、embed 参数编码、
  真实后端 JSON 解析、无地址频道过滤、缺字段容错、兜底频道可用性

**3) 后端链路**（`tools/verify_backend_endpoints.js`，用与 App 完全相同的编码规则复现请求）
- `12 项全部通过，0 失败`
- 频道列表 200 / 59 台 / 7 个分组
- 配置接口返回 `replayUrl` 与后端版本 `0.3.13`
- 直播中继 **8/8 台 HTTP 200 且返回合法 #EXTM3U**
- 回放 `/api/embed` 返回 88KB HTML，**详情页里的播放器 iframe 已被接管**
- 真实媒体分片可达：`TV Chosun` 6.3MB(TS) / `TV Chosun 2` 2.0MB(TS) / `Arirang` 107KB(TS)

### 尚未验证（如实说明）
- **真机/模拟器上的实际界面与播放**：
  本机模拟器**无法启动** —— x86_64 模拟器要求硬件加速，而本机未安装
  Android Emulator hypervisor driver（`emulator -accel-check` 返回 6），
  强开 `-feature WindowsHypervisorPlatform` 亦无效（该 Windows 功能未启用）。
  安装该驱动属系统级改动（需管理员权限、可能重启），未擅自执行。
- 电视盒子上的 WebView 版本可能导致回放页表现差异，需按实际设备验证。
- 首版不含 EPG 节目单（后端 `/api/epg` 已存在，留待后续版本）。

### 产物
- `tvlive-android-v1.0.0.apk`（工程根目录，6.7 MB）
- 源码与工程配置见本目录；构建命令见 `README.md`

### 模拟器环境顺带调整（与 App 无关）
为在 D 盘跑模拟器，把两台 AVD 从 `C:\Users\LeoNFiona\.android\avd` 复制到
`D:\WorkBuddy\android-avd`，并把数据分区从 6GB 调小到 3GB（C 盘仅剩 7.2GB，原配置需要 7.37GB 直接 FATAL）。
原 C 盘 AVD 未删除。
