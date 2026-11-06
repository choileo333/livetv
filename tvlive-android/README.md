# TvLive — 直播/回放 安卓 App（手机 + 电视）

同一份 APK，手机（触屏/竖屏）与电视/盒子（遥控器/横屏）都能用。
直播走**自建后端的中继**（破解地域封锁），回放**复用网页版已验证可播的方案**（内嵌网页）。

> 本工程与 `re-soft/tv-iptv/` 是配套关系：`tv-iptv` 提供后端与网页版，本工程是它的安卓客户端。

---

## 一、依赖的后端

| 接口 | 用途 |
|---|---|
| `GET /api/channels` | 频道列表（当前 59 台，含韩国/电影/新闻等分组） |
| `GET /api/relay?url=<编码后的流地址>` | 中继代理：服务端代取流并补 Referer，破解地域封锁 |
| `GET /api/embed?url=<编码后的回放站地址>` | 内嵌代理：注入播放器补丁，使回放可在内嵌页面内正常播放 |
| `GET /api/config` | 取回放站地址（可随时在服务端改，App 无需重装） |

线上地址：`https://tvlive-relay.app.workbuddy.host/`

App 内的后端地址**可在界面上随时修改**（局域网自建亦可），默认指向线上地址。

---

## 二、构建

本机环境（实测）：
- JDK：Android Studio 自带 `E:\Program Files\Android\Android Studio\jbr`（JDK 21）
- Android SDK：`E:\SDK_Android`（platform-34 / build-tools 34.0.0）
- Gradle：本目录 `tools/gradle-8.2`（随工程携带，不依赖 C 盘全局安装）

构建命令（Git Bash）：

```bash
export JAVA_HOME="/e/Program Files/Android/Android Studio/jbr"
cd "/d/WorkBuddy/work_space/2026-10-11-14-07-38/re-soft/tvlive-android"
"./tools/gradle-8.2/bin/gradle" :app:assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`
发布归档：`tvlive-android-v1.4.4.apk`（工程根目录，按版本号命名，旧版保留不覆盖）

安装到设备/模拟器：

```bash
"/e/SDK_Android/platform-tools/adb.exe" install -r "tvlive-android-v1.4.4.apk"
```

跑单元测试（纯 JVM，不需要设备）：

```bash
"./tools/gradle-8.2/bin/gradle" :app:testDebugUnitTest
```

跑链路验证脚本（Node，直连线上后端复现 App 的请求）：

```bash
node tools/verify_channel_parity.js     # 频道清单一致性：网页版 vs App（含韩国组逐条对照 + relay 状态）
node tools/verify_hls_chain.js          # HLS 全链路：列表→master→子清单→真实分片
node tools/verify_backend_endpoints.js  # 后端各接口 + 频道中继可用性
node tools/verify_tvnav.js              # 回放页脚本：语法校验 + 无头浏览器真实按键/点击 + 诊断上报与黑屏自愈
node tools/verify_scroll_live.js        # 边缘滚动：在【线上真实回放站】上注入脚本按方向键，看页面是否真的滚
node tools/verify_rescue_live.js        # 播放器兜底三场景：① 反调试清页 ② 播放器没建出来→自建并真的出画面 ③ 正常时不插手
node tools/verify_cleanup.js             # 播放页去广告+单列重排：加载真实详情页，断言广告归零、播放器+播放列表留存、整页可滚动
```

排查用探针（只在需要看站点现场时跑，产物落在 `tools/probe_out/`）：

```bash
node tools/probe_m3u8_fresh.js          # 现抓流地址并试不同 Referer（判断「地址错」还是「防盗链」）
node tools/probe_stream_net.js          # 全程网络监听：站点自己请求什么流、带什么头、回什么状态、video 什么状态
node tools/probe_timeline.js            # 站点反调试的时序（谁把页面导航去了 about:blank）
```

---

## 三、目录结构

```
tvlive-android/
├── settings.gradle / build.gradle / gradle.properties   工程与构建配置
├── local.properties                                     SDK 路径（机器相关）
├── tools/gradle-8.2/                                    随工程携带的 Gradle 发行版
├── tools/verify_channel_parity.js                       频道清单一致性验证（网页版 vs App）
├── tools/verify_hls_chain.js                            HLS 链路验证（复刻 ExoPlayer 取流）
├── tools/verify_backend_endpoints.js                    后端接口验证
├── tools/verify_tvnav.js                                回放页脚本验证（红点光标 + 诊断上报 + 黑屏自愈，无头浏览器实跑）
├── tools/verify_scroll_live.js                          边缘滚动验证（跑在线上真实回放站上）
├── tools/verify_rescue_live.js                          播放器兜底三场景验证（反调试清页 / 自建播放器真出画面 / 正常时不插手）
├── tools/verify_cleanup.js                              播放页去广告+单列重排验证（加载真实详情页，断言广告归零+播放器/播放列表留存+整页可滚动）
├── tools/probe_m3u8_fresh.js                            探针：现抓流地址并试不同 Referer
├── tools/probe_stream_net.js                            探针：全程网络监听站点自己怎么取流
├── tools/probe_out/                                     探针抓回的站点现场文件（证据留档）
├── app/
│   ├── build.gradle                                     模块配置（包名/版本/依赖）
│   └── src/
│       ├── main/
│       │   ├── AndroidManifest.xml                      双入口（手机 LAUNCHER + 电视 LEANBACK）
│       │   ├── java/com/leo/tvlive/
│       │   │   ├── App.kt                               全局初始化
│       │   │   ├── data/Channel.kt                      频道数据模型（含 relay 标记）
│       │   │   ├── data/ChannelRepo.kt                  频道拉取（后端优先，内置兜底）
│       │   │   ├── data/MimeHint.kt                     MIME 推断（纯逻辑，可单测）
│       │   │   ├── data/Prefs.kt                        本地偏好（后端地址/收藏/上次频道）
│       │   │   ├── player/LivePlayer.kt                 直播播放（ExoPlayer，走中继）
│       │   │   ├── ui/MainActivity.kt                   主界面（手机/电视自适应）
│       │   │   ├── ui/ChannelAdapter.kt                 频道列表适配器
│       │   │   ├── util/DeviceUtil.kt                   设备形态判定（电视/手机）
│       │   │   └── util/TvNavScript.kt                  回放页「红点鼠标」光标脚本（注入 WebView）
│       │   └── res/
│       │       ├── layout/activity_main.xml             手机竖屏布局（列表 ⇄ 全屏播放）
│       │       ├── layout-land/activity_main.xml        横屏/电视布局（左侧列表 + 右侧播放）
│       │       └── ...
│       └── test/java/com/leo/tvlive/CoreLogicTest.kt    纯 JVM 单元测试
└── HISTORY.md                                           变更记录
```

---

## 四、关键设计

**1. 直播默认走中继，但必须尊重后端的 `relay` 标记。** 频道源地址直连在很多网络下打不开
（地域封锁 / 需要特定 Referer），网页版之所以能播正是因为走了 `/api/relay`，App 同样如此。
**但**：后端会给少数频道标 `"relay": false`，含义是「连上海中继都够不到，只能本机直连」
（线上有 6 个：`137 KBS 1TV`/`138 KBS 2TV`/`139 JTBC`/`140 SBS`/`141 MBC` 首尔主台 + `163 凤凰卫视中文台`）。
网页版规则是 `useRelay = relayOn && ch.relay !== false`，App 必须照做：
播放地址 = `Backend.playUrl(base, ch.url, ch.relay)`（true → 中继地址；false → 源地址）。
> 这条规则在 v1.1.1 才补上。此前 App 无视该字段、一律套中继，导致这几个台在网页版能试、
> 在 App 必然报错，表现为「台在列表里但一点就不行」。详见 `HISTORY.md` v1.1.1。

**2. 回放复用网页方案。** 回放站的真实流在**另一个域名**上（如 `wiselife.blog/...m3u8`），
由 `xiaoca.top` 的播放器页面按 Referer 白名单决定发不发真实地址；真实流还有第二层防盗链。
浏览器无法伪造跨域 Referer，所以必须由服务端代劳——这套逻辑网页版已实现并实测通过
（见 `tv-iptv/HISTORY.md` v0.3.13）。App 内直接用 WebView 打开 `/api/embed?url=<回放站>`，白捡这套能力。

实测的真实站点结构（2026-10-12 抓线上页面确认，不是猜的）：

| 页面 | 结构 | 对红点光标的意义 |
|---|---|---|
| 列表页 `show.php?tid=3` | 视频卡片 = `<a href="/api/embed?url=...shplay.php?id=...">`，**同源相对地址** | 原生 `click()` 直接跳转进播放页 |
| 播放页 `shplay.php?id=...` | `<iframe id="adFrame">` 跨域广告 + `<iframe id="view_iframe" src="/api/embed?url=https://xiaoca.top/...m3u8">` **同源** | 播放器在同源 iframe 里 → 光标脚本**必须支持钻进同源 iframe** |
| 同上，广告层 | 该页自带 `countdown = 6` 倒计时，到点执行 `adFrame.style.display='none'` | 跨域广告**无需用户操作**，等 6 秒自行消失 |

**3. 手机与电视共用一套代码。** 通过 `res/layout` 与 `res/layout-land` 两套布局（控件 id 完全一致）
适配两种形态，代码里用 `DeviceUtil.isTelevision()` 决定交互方式：
- 手机：列表 ⇄ 全屏播放 页面级切换，点频道进播放页，返回键回列表
- 电视：左列表 + 右播放常驻，遥控器方向键导航、确定键切台、数字键直选

**4. 明文 HTTP 已放开。** 频道源与自建后端大量使用 `http://`（含 `relay:false` 需直连的
KBS 1TV/2TV），Android 9+ 默认禁止，已在清单中显式开启（`android:usesCleartextTraffic="true"`）。

**5. 【重要】HLS 必须显式声明 MIME。** 播放地址经中继包装后是 `/api/relay?url=...`，
**路径末段不含 `.m3u8`**，而 Media3 判断容器类型只看路径末段后缀 → 会把 m3u8 当普通 MP4 解析，
报 `ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED`。
所以 `LivePlayer.play(url, mimeType)` 必须带上由**源地址**推断出的 `MimeHint.of(ch.url)`。
> 记住：MIME 要拿**源地址**推断，不能拿中继地址 —— 中继地址的后缀已不可信。

**6. 【重要】电视端控件必须同时声明 `focusableInTouchMode`。**
实测机型（小米电视）的应用窗口运行在**触摸模式**下，只写 `focusable="true"` 的控件
遥控器**完全选不中**（2026-10-12 真机截图确认）。凡是希望被遥控器选中的控件，
XML 里 `android:focusable` 与 `android:focusableInTouchMode` 必须成对出现；
代码动态创建的控件要设 `isFocusable = true` + `isFocusableInTouchMode = true`。
另外，**必须给出可见的焦点反馈**（本项目约定：当前状态红底白字 / 仅聚焦灰底白字 / 普通透明底灰字），
否则用户看不到光标在哪。

**7. 【重要】切换分组时不要重建按钮视图。** 重建会立刻丢掉焦点，用户每次选分组都要重新导航。

**8. 【重要】全屏按钮必须自己实现，且只保留它一个。** Media3 的 `PlayerView` **内置没有全屏按钮**，
且直播流不可拖动时它会隐藏进度条、只留下一个「速度」按钮（用户真机反馈「没有全屏、下面像被去掉了」）。
本项目关掉内置控制器（`app:use_controller="false"`），改用自绘控制条 `live_controls`，
**只放一个「全屏 / 退出全屏」**（v1.1.0 起按用户要求删掉「播放/暂停」「静音」），
全屏时隐藏左侧列表 + 顶栏 + 系统栏。
> 注意一：自绘按钮若不做焦点连线（列表按「右」→ 控制条），电视上根本走不到，按钮等于摆设。
> 注意二：**回放模式下方向键被网页接管，遥控器无法再聚焦这个按钮** ——
> 故 v1.1.0 加了「长按确定键 700ms = 切全屏」与「菜单键 = 切全屏」两个替代入口。

**9. 【重要】回放页用「红点鼠标」而不是「选框跳元素」（v1.1.0 重写）。**
WebView 没有内建的「方向键在网页里移动焦点」能力，遥控器在网页里会完全没有反应。
上一版的做法是枚举可交互元素、方向键在元素之间跳、红框框住当前元素；实测三大硬伤：
只能点到「被判定为可交互」的元素（有盲区）、换个站点 DOM 结构不同就失灵、与「指针」的直觉不符。
现在改成**鼠标隐喻**（`util/TvNavScript.kt`）：
- 屏幕上一个圆形红点，方向键按固定步长挪它（步长 = 视口尺寸的比例，手感与分辨率无关）；
- 确定键 → `document.elementFromPoint(x, y)` 命中最深层元素 → 补发
  `mousemove/mouseover/mousedown/mouseup` → 再调**原生 `click()`**
  （只有原生 click 才触发链接跳转等默认行为，合成事件 `isTrusted=false` 不触发）；
- **移上去就补悬停事件**：大量播放器只在鼠标悬停时才显示控制条，不补会出现「点到了但按钮不存在」；
- 命中 iframe 时取 `contentDocument` **钻进去**（同源可以，跨域不行）；
- 初始落点优先落在视频中心（找不到顶层 video 就钻进同源 iframe 找）；
- **红点贴到屏幕边缘后 → 朝该方向滚动页面**（v1.2.0 重做，见下条）；
- 红点本身必须 `pointer-events:none`，否则它自己会挡住命中测试 —— 这是整套方案的命门。

**9b. 【重要】边缘滚动必须做成「由内到外的接力」，且不能只认 `scrollingElement`（v1.2.0）。**
红点贴到视口边缘后继续按同一方向 → 应**朝该方向滚动页面**（一屏放不下时这是唯一走法）。
两个容易踩的坑：
- **判定带不能太窄**。旧值 6px —— 红点半径就有 9px，贴到 6px 时红点已被切掉一半，用户看不见自己在哪。
  现在 `BAND = 36`（贴边判定带），另加 `HARD = 8`（硬边界：页面滚到头时红点仍能贴到 8px，
  否则最右/最下 36px 的内容永远点不到）。
- **不能只试 `document.scrollingElement`**。那是 Chrome 51 之后才有的属性，
  老旧电视盒子的 WebView 没有；怪异模式（老站常见）下滚的是 `<body>` 而不是 `<html>`。
  两种情况都会让「滚没滚」判断成 false → **红点静静贴边、页面纹丝不动**（且无任何报错）。
  现在 `scrollDocRoot()` 把 `scrollingElement` / `documentElement` / `body` **三个都试一遍**。
- **滚动顺序由内到外**（与浏览器滚轮一致，scroll chaining）：先滚红点所在的可滚祖先容器，
  滚到头再滚整页。反过来先滚整页的话，红点停在内部滚动列表上时，用户永远看不到列表后面的条目。
  线上实测播放页就有这样一个容器（`.play-box-side-main`）。
- 兜底还有一个几何扫描（`scanScrollable`），应对「滚动容器不是红点祖先」的少见结构；
  先做便宜的尺寸判断再读样式，避免在弱 CPU 的盒子上卡顿。

**10. 【重要】焦点反馈除了底色还要有边框。** 只改底色在电视上不够显眼，
统一用 `paintFocus()` 叠一层 **2dp 白色描边**（白色在任何底色上都可见，包括红底选中态）。

**11. 【重要】回放模式按「返回」先让网页后退。** 回放站是多级站点（列表页 → 播放页），
红点能点进去之后必须能退回来：否则退回直播再点「回放」还是那一页（WebView 没有重载），用户被困住。
顺序：能退网页就先退网页 → 退到网页第一页才回直播。

**12. 频道清单与网页版共用同一接口，两端本就一致（v1.1.1 实测固化）。**
网页版与 App 都读 `/api/channels`；App 侧 `parseChannels` 只丢弃 `url` 为空的条目
（线上没有这种条目），分组筛选与网页版同规则（按 `group` 全等）。
线上现状 **59 台 / 韩国 31 台**，两端逐条同号同名。
为防止「以后哪天不一样了却没人发现」，做了两层固化：
- `tools/verify_channel_parity.js`：拉线上数据，按两端规则各算一遍并逐条比对（含韩国组详表）；
- 单测 `app_sees_same_korean_channels_as_web`：**把线上响应存成夹具**
  （`app/src/test/resources/channels_live.json`），用 App 自己的解析代码跑，
  并把 31 个台号序列钉死 —— 任一端增删都会立刻测试失败。
> 附：状态行会显示当前分组台数（如「分组「韩国」共 31 台」），方便在电视上直接核对有没有缺台。

---

## 四之二、回放页黑屏时怎么看原因（v1.3.0 起有诊断，v1.4.2 起能自愈）

**现象**：电视上点进具体视频后一直黑屏、连播放按钮都不出现，而手机上是正常的。

**结论先说**：这种情况**差异只在设备环境**（同一份代码、同一个页面），
而在此之前 App 对网页里发生的一切完全无感 —— 无论根因是什么，用户端都只是一块黑屏。
v1.3.0 起，App 会把这些原因**采集下来**：**v1.4.3 及以前**直接打在状态行/回放提示条上（`⚠ 标签：内容`）便于拍屏定位；**v1.4.4 起按用户要求不再上屏，只写 logcat（`tag=TvLive`）**，需要时 `adb logcat -s TvLive` 取；红点旁的「位置提示」保留。
v1.4.2 起更进一步：**站点播放器建不出来时，我们自己建一个接着播，而且不依赖站点 `common.js` 是否成功执行**（详见 `HISTORY.md` v1.4.2）。

### 怎么读这些提示

| 屏幕上出现 | 含义 | 能不能修 |
|---|---|---|
| `本机播放能力不足：mse=no …` | 这台设备的 WebView 没有 `MediaSource`（或原生 HLS），播放器脚本必然初始化失败 | **不能**，是设备能力上限 |
| `网页引擎重启：渲染进程被系统回收…` | 老盒子内存不足，网页渲染进程被系统杀掉（现象正是「突然全黑且不报错」） | App 会**自动重建网页**，属缓解 |
| `网页 JS 报错：…` | 播放器脚本自己抛错，后面的初始化没执行 | 看具体报错，多在源站侧 |
| `请求被拒：HTTP 403 …` | 取流/页面被源站防盗链拒绝 | 服务端中继的事 |
| `网页打不开：错误码 …` | 主文档根本没加载出来（网络/中继问题） | 先查网络与后端地址 |
| `拦截跳转：站点反调试想把页面跳到错误页…` | 站点反调试脚本想把页面踢走，已被我们拦下（页面留在播放页） | **已修**，无需处理 |
| `页面被清空：站点反调试脚本把页面清成了空白…` | 拦截没赶上（换了新域名/新写法），App 会**自动重载一次** | 若反复出现，请把这句话拍给开发者 |
| `自建播放：站点播放器未渲染，开始在播放器容器里自建…` | 站点播放器没建出来，**兜底播放器已接管** | 正常路径，画面应已恢复 |
| `视频状态：页面里没有 video 元素（站点播放器没建出来）` | 页面上根本没渲染出播放器 | 兜底会接力；若最终仍黑屏，把这行拍给开发者 |
| `视频状态：有 N 个 video 但全部没显示…` | 播放器建出来了但被广告遮罩盖着/尺寸为 0 | 12 秒后兜底会强制放开遮罩 |
| `视频状态：有 N 个可见的 video，但都还没开始播…` | 播放器在屏幕上，只是卡在暂停/缓冲 | 自愈会替用户按一次播放 |
| `视频状态：播放出错 code=…` | 视频元素已存在但解码/加载失败（code 1=中止 2=网络 3=解码 4=源不支持） | 多为设备解码能力或流不可达 |

### 设计取舍（为什么这么做）

- **诊断一直在采集，展示方式两度调整**：v1.3.0–v1.4.3 回显到屏幕（电视上装不了开发者工具，只有屏幕可拍）；**v1.4.4 起按用户要求不再上屏**，改为只写 logcat（`tag=TvLive`），需要时 `adb logcat -s TvLive` 取。
- **上报通道用 `console.log` + `__TVNAV__` 前缀**，不额外挂 `JavascriptInterface` 桥：
  单向、老 WebView 也稳、且天然落在已有的 `onConsoleMessage` 上。
- **自愈刻意设限**：只在注入后 20 秒内动手，且「替用户按播放」「上报无视频」各自最多一次 ——
  之后再干预就会把用户主动的暂停又播回来，那是添乱而不是修复。
- **`onRenderProcessGone` 必须返回 `true`**：返回 `false` 时系统会认为应用处理不了，
  **连带把整个应用进程杀掉**（这是 Android 文档明确写的坑）。
- **取流首选读 `window.vid`，读不到就自己复刻解密**（v1.4.2）：站点用 base64+XOR 把真流地址藏在 `vid` 里。
  正常情况下直接读 iframe 里**站点已经解好的 `window.vid`**；真机上常因 `common.js` 未执行导致 `vid` 未定义，
  此时兜底脚本会读 onet.php HTML 里的 `phpsiteEc2` / `phpsitekey3`，自己复刻 base64+XOR 解密算出真实流地址。
- **兜底播放器不删站点 DOM，只盖在上面**（v1.4.1）：用绝对定位 + `z-index:11`（压过广告的 10）铺满容器。
  这样万一站点播放器后来又活了，两不相扰；且 45 秒后我们就收手，不做无限重试把电视 CPU 拖死。

---

## 五、已知边界（如实说明）

- **遥控器实际手感未经设备实测**：焦点链路的依据是 Android 焦点机制 + 编译后布局属性核对
  （`aapt2 dump xmltree`）+ 单元测试 + 无头浏览器的真实注入/按键/点击回执，但本机模拟器无法启动
  （缺 hypervisor 驱动），「红点移动速度是否顺手、长按 700ms 是否好触发」仍需真机确认。
  详见 `HISTORY.md` v1.0.0 / v1.0.1 / v1.1.0。
- 回放依赖 WebView 加载远端页面，**老电视盒子的 WebView 可能偏旧**，能否播放需按实际设备验证。
  **电视上黑屏而手机正常时，先看状态行的 `⚠` 提示**（含义对照表见第四之二节）——
  v1.3.0 起这类问题不再是「无从查起」，而是「屏幕上有答案」；v1.4.2 起更进一步，站点播放器建不出来时**兜底会自己建一个接着播，且不依赖 common.js 是否执行**。
  边缘滚动正是为这类老内核做了防御：`scrollDocRoot()` 同时试
  `scrollingElement`/`documentElement`/`body`（老 WebView 没有前者、怪异模式滚后者）。
- **回放取流不读 iframe 的 src，只读播放器页的 `window.vid`（读不到就自己解密）**（v1.4.2 用实测换来的结论）：
  详情页 iframe 的 src 里那串 `https://wiselife.blog/pop/<id>.m3u8` **恒返 404，是不可播的频道入口**；
  真正的流是播放器页 `common.js` 用 base64+XOR 解出的 `vid`（`https://wiselife.blog/hls/<id>.m3u8?t=..&n=..&s=..`，
  **带服务端签名、每次请求都变**）。因为 iframe 经后端 `/api/embed` 代理后与顶层**同源**，我们直接读 `contentWindow.vid` 即可。
  正常时 `vid` 由**同步脚本**算出、挂在 iframe 顶层作用域 —— **即使站点播放器全挂掉，`vid` 也已经有值**。
  真机常因 common.js 未执行导致 `vid` 未定义，此时兜底脚本会读 onet.php HTML 里的 `phpsiteEc2`/`phpsitekey3`，自己复刻 base64+XOR 解密算出真实流地址。
  判定「这串是不是 m3u8」必须看 **pathname 以 `.m3u8` 结尾**，不能用 `indexOf('.m3u8')`
  （`onet.php?url=xxx.m3u8` 这类「m3u8 只是查询参数」会被误判，喂给 hls.js 就是 `manifestParsingError`）。
- **站点有两套以上反调试**，且其中一套是 **inline 脚本**（写在 onet.php 的 HTML 里，请求层拦不掉）：
  故防御是三层叠加 —— ① `shouldInterceptRequest` 拦掉外部反调试脚本文件；
  ② `cacheMode = LOAD_NO_CACHE` 保证拦截每次都能命中（**缓存命中不产生请求 ⇒ 回调不触发 ⇒ 拦截时灵时不灵**）；
  ③ `shouldOverrideUrlLoading` 拦住它最后的「跳错误页」手段。
- 回放页的跨域 iframe 受浏览器同源策略限制，红点点不进去（硬限制，不是实现缺陷）。
  真实站点里唯一跨域的是**广告 iframe `#adFrame`**，v1.4.3 起已由 `ReplayCleanupScript` 立即移除（DOM 层删节点 + `AD_RE` 在网络层拦掉它的请求），
  不再依赖站点自己的 6 秒倒计时——这也顺带避免它卡住主文档 `load`、拖慢红点注入。
  播放器 iframe 是后端改写的**同源**地址，可以钻进去点。
  同理，跨域 iframe **内部自己滚动**我们也滚不了，只能滚外层（v1.4.3 已把播放页重排成单列整体可滚动，避开这个坑）。
- 中继在服务端，App 不承担反封锁逻辑；若后端不可达，直播不可用（列表会回退到内置 2 台兜底数据，
  此时状态行会显示「后端不可达」——台数与网页版的 59 台不符时，先看这行文案）。
- **`relay:false` 的 5 个韩国地面波主台（KBS 1TV/2TV、JTBC、SBS、MBC 首尔主台）不保证能播**：
  它们的公开源受地域封锁，连上海中继都够不到，只能靠你的家宽直连碰运气。
  v1.1.1 改成直连，只是**把网页版给过的机会同样给到 App**，不是修好了源。
- 首版不含 EPG 节目单（后端 `/api/epg` 接口已存在，留待后续版本接入）。
