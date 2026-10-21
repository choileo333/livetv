# TvLive 当前状态快照 / 交接文档

> 快照时间：**2026-10-21 17:0x（GMT+8）**（本次为 v0.3.17「删 4 台 + 8 台改韩文名」交付后更新）
> 用途：用户暂停工作（休息），下次续接时按本文档即可回到现场，无需重新排查。
> 维护规范：每次阶段性暂停时更新本文档；逐版改动细节见同目录 `HISTORY.md`。

---

## 一、当前版本
- 后端 `server.js`：**v0.3.17**（`VERSION` 常量在第 17 行；`/api/health` 会返回版本号）
  - v0.3.17：**删除 4 台**（EBS 2TV id=109、Gugak TV id=119、国防 TV id=122、RTV id=147）；**8 台改韩文名**（101→TV 조선、100→TV조선2、118→농협tv、130→대전MBC、133→청주SBS、135→제주MBC、136→전주SBS、166→강원SBS），`CHANNELS` 与 `EPG_TITLES` 同步。总数 **59→55**，韩国 **32→28**。
  - v0.3.16：新增 **G1 (SBS 江原)**（id=166，`relay:false` 仅本机直连，v0.3.17 已改名 강원SBS）；SBS 九家地方台全量复查（结果见 HISTORY v0.3.16 表）。
  - v0.3.15：**CCTV-1（id=165）/ CCTV-13（id=164）** 换成江苏电信 IPTV 网关真台源 `219.147.245.238:25480`（ffmpeg 抽帧验证台标）；**凤凰卫视（id=163）摘除**——系统性排查后确认无任何可用公开源（详见 HISTORY v0.3.15 排查表）。
  - v0.3.14：把 **YTN（id=105）** 的死源换成 **YTN 官方源** `ytnlive.ytn.co.kr`（清单/分片/中继全通，无签名无加密）。
  - v0.3.11 起新增：`REPLAY_URL` + `GET /api/config`、`GET /api/embed`（内嵌代理，破 XFO/CSP）、`GET /api/relay` 的 `raw=1` / `ref=` 支持
- 前端：`backend/web/`（`index.html` / `app.js` / `style.css` / `hls.min.js`），后端 URL 用 `BACKEND = ""`（同源），本地与云端通用
- 项目根：`D:\WorkBuddy\work_space\2026-10-11-14-07-38\re-soft\tv-iptv\`

## 二、运行中的服务（实测确认）
| 服务 | 地址 | 状态 |
|---|---|---|
| 本地后端 | `http://localhost:8899/` | ⏸ 当前**未运行**（v0.3.13 验证走的是线上；需本地调试时按下方命令启动） |
| 云端部署（中继+播放页） | **https://tvlive-relay.app.workbuddy.host/** | ✅ 运行中，`/api/health` 返回 `version:0.3.14`（2026-10-15 09:4x 实测） |


- 本地启动命令（如需重启）：
  ```
  cd "D:/WorkBuddy/work_space/2026-10-11-14-07-38/re-soft/tv-iptv/backend"
  "C:/Users/LeoNFiona/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" server.js
  ```
- 停止本地后端（8899）：
  ```
  netstat -ano | grep ":8899" | grep LISTENING | awk '{print $5}' | head -1   # 取 PID
  taskkill //F //PID <PID>
  ```
- 云端应用可在 **「设置—数据管理—应用」** 中管理（下线/重部署）。
- 部署入口：`domainPrefix = tvlive-relay`，`appName = TvLive 电视直播`。

## 三、频道现状
- **总数 55**（v0.3.17 起，删 4 台后）：韩国 28 / 测试 1 / 新闻 5 / 音乐 3 / 纪录片 5 / 体育 3 / 电影 10
- **v0.3.16 SBS 地方台结论（重要，勿重复排查）**：
  - 可用：**CJB 清州**（中继+本机双通，720p）、**JTV 全州**（双通，406p）、**G1 江原**（id=166，仅本机直连 relay:false，720p/1.26Mbps）。
  - 不可用（已实测）：KNN（nginx IP 白名单 403）、KBC、TBC（CF 端口协议异常+TLS 握手失败）、TJB、UBC、JIBS（清单可读但分片取不到）、SBS Plus/Star/International（nextologies 国内+云端均不通）、SBS 首尔主台（azure2986 DNS 已失效）。
  - 另：`ythls.armelin.one`（YouTube→HLS 转接）已死，别再指望用 YouTube 源救锁区台。
- **v0.3.15 频道结论（重要，勿重复排查）**：
  - CCTV-1 = `219.147.245.238:25480/newlive/live/hls/1/live.m3u8`、CCTV-13 = `.../hls/14/...`。该江苏电信网关 hls/1–17 全为央视、40–50 西部卫视、85–107 各省卫视（已逐台抽帧识别），**不含凤凰/KTBS 等其它台**。
  - **凤凰卫视无任何可用公开源**（ifeng 官方 ID 失效仅剩静态占位、央视式 DRM、移动/联通/电信 IPTV 后端云端全不可达、凤凰秀 HLS 变体 CDN `livehwc4.com` 本机+云端均不可达、fanmingming 权威清单无凤凰）。后续若用户再提凤凰，先看 HISTORY v0.3.15 排查表，勿重复扫源。
- 已按用户要求做的清理：删除全部儿童频道、印度台（含 B4U 全系、Alankar、Cricket Gold、**All Time Movies（Hindi）**）、不知名体育台（非洲/阿拉伯/astrahan.ru/canal）、美国/阿拉伯/伊朗/阿根廷的小众电影台（30A TV / Aflam / Afra Film / AlternaTV）、`HLxx-DTV` 地区台去重（仅保留 `HLAO-DTV 720p`）、**`KBS Joy`（唯一公开源是冻结假直播，不可修复）**
- **v0.3.3 新增**：韩台 `Daejeon MBC`、`Daegu MBC`、`Chuncheon MBC`、`CJB Cheongju SBS`、`GCN`；修复 `EBS 1TV` 源；新增 10 个优质电影台（Hallmark / MovieSphere 系 / Rakuten TV / Ebony TV by Lionsgate / Warner TV Asia / HBO Hits / AMC / Popcorn Central / MyTime UK）
- 韩国台已置顶（前 6：TV Chosun、TV Chosun 2、Arirang TV、Arirang TV HD、Arirang Radio、KTV）

## 四、实测可稳定播放的频道（决定性指标 ratio = 分片下载耗时 ÷ 分片播放时长）
| 频道 | 本地实测 | 云端（上海节点）实测 | 判定 |
|---|---|---|---|
| TV Chosun | 8.4 Mbps / ratio 0.38 | **29.1 Mbps** | ✅ 流畅 |
| TV Chosun 2 | 7.4 Mbps / ratio 0.16 | **22.4 Mbps** | ✅ 流畅 |
| FGTV（含 296kbps 480p 档） | 4.1 Mbps / ratio 0.22 | **17.7 Mbps** | ✅ 流畅 |
| RUTC TV（CloudFront） | 37.0 Mbps / ratio 0.15 | 5.8 Mbps | ✅ 流畅 |
| Arirang 系 | 1.1~1.4 Mbps | — | ✅ 可播 |

- 端到端实测（云端中继取 TV Chosun 5.9 Mbps 流）：连续 3 分片 `1.36s / 1.56s / 1.17s(命中缓存)` ≈ **36 Mbps**，余量为码率的 6 倍。

### 晨间复查（2026-10-12 08:57，本机深度探测）
- **可达性随时间变化明显**：韩国组 `ok 12 / slow 1 / dead 17`（昨晚同类探测仅 5 个 ok）。多数为早间播出时段恢复的 `[Not 24/7]` 台。
- 本晨实测 `ok` 的韩台：TV Chosun(19.0M)、TV Chosun 2(19.4M)、Arirang TV(1.4M, ratio2.33)、KTV(2.8M)、FGTV(4.0M)、RUTC TV(34.9M)、KBS Joy(15.7M)、NHTV(8.7M)、ABN(2.6M)、Gugbang TV(4.8M)、HLAO-DTV(7.1M)、OUN(16.9M)。`慢`：Arirang Radio(486k)。其余 17 个 dead（EBS 全系 / YTN / TBS / Channel A / KCTV / RTV / MTN / Gugak / 国会台 等）。
  - ⚠️ **该行已被 v0.3.14 部分推翻**：`YTN` 当时 dead 是因为源（iptv-org 的 `202.60.106.14:8080`）已死，**已换成 YTN 官方源并实测全通**（见 HISTORY v0.3.14）。其余台状态未重测。
- **注**：`ratio` 语义 = 分片时长 ÷ 下载耗时（越大越快；≥1.3 ok）。已修正源码中写反的注释（见 HISTORY v0.3.2 补丁）。

## 五、已完成的工程改进（均在 v0.3.x）
1. **选台高亮优化**：`updateActive()` 只切 `.active` 类，不再整列重建 DOM（解决图标每次刷新）。
2. **后端中继代理 `/api/relay`**：改写嵌套 m3u8（`#EXT-X-KEY`、变体、分片 URI）回指中继，突破跨域/地域限制。
3. **中继增强**：keep-alive 连接池 + 播放列表 4s 缓存 + **分片预取 read-ahead**（已从"并发 4 段"修正为"**顺序 1 段、跳过播放中分片**"——原并发预取在窄国际线路上与播放抢带宽，属自伤回归，已修复）。
4. **修「中继开启后播放变快 1.5~2×」**：`maxLiveSyncPlaybackRate: 1` + `liveSyncDuration: 20`（禁追帧）。
5. **可达性探测升级**：`/api/check` 从"读 700 字节判列表"升级为"**真实拉一个分片测吞吐**"，返回 `ok/slow/dead` 三态 + 实测 kbps；加**硬性总时限**（Node 空闲超时挡不住慢速滴流）、并发 12、60s 缓存。全量约 20 秒。
6. **UI 三态圆点 + 图例**（绿=流畅 / 黄=偏慢 / 红=不可用，悬停显示 kbps）。
7. **播放看门狗**：选台 16s 未出画面提示"源带宽不足/不可用，建议换台"；单次缓冲超 12s 提示"源过慢"。消灭无限"缓冲中"。
8. **中继开关按钮**「中继：开/关」可实时切换。
9. **「冻结假直播」识别（v0.3.3 根因级修复）**：`checkDeep()` 增加 `#EXT-X-PROGRAM-DATE-TIME` 新鲜度判据 —— 直播型列表若最新 PDT 距今 > 300 秒即判 `dead(stale)`。修掉了「KBS Joy 绿点却反复缓冲」的假绿点（其源是 GitHub Pages 上的静态冻结列表，实测陈旧 53.7 天、后续分片 404）。

## 六、诚实边界（勿在下次重复踩坑）
- **中继只能救"能连通但余量小"的台**，救不了"源已死 / 源被地域封锁"的台。
- **韩国旗舰台 KBS1 / SBS / MBC / JTBC / tvN**：公开免费源里没有可用国际直链（被韩国 IP 限制），免费源救不回来。
- **内置部署不在境外**：实测出口为 **上海 / 腾讯云（111.229.174.181, AS45090）**，与用户同国，**无法突破地域封锁**；但它国际带宽远优于家宽（对可播韩台余量 1.4× → 5×）。
- **本机代理探测结论**：`127.0.0.1:1928` 是 WorkBuddy 内部服务代理、`8080` 是 node 进程，**都不是可用的通用代理**。

## 七、逆向分析结论（用户上一个问题）
- 用户提供的逆向产物：`re-soft\reversed\`（`SUN1246-1.apk`，包名 `com.lemo.fairy`，代号"精灵"）。
- 结论：流畅源于 **ForceTV P2P + 私有 HTTP-CDN + 授权源 + 边缘低码率转码**，属**商业基础设施**，不是浏览器可抄的技巧。
- 二进制实证：`lib/arm64-v8a/libforcetv.so` 含 `all_chan_p2p_info`、`check_for_httpcdn`、`set_disk_cache_space`、`slow send pack`、`&lencese=` 等符号；播放器只读本地 `http://127.0.0.1:9906`。
- **单用户可借鉴的唯一条**：不是播放器参数，而是"**境外 VPS 用韩国 IP 取流 + ffmpeg 转低码率 HLS 回传**"。

## 八、待用户拍板的下一步（等回复）
- **A**：把 relay 升级为**磁盘缓存 + 高低水位流控**（借鉴逆向 App 的 ①；只对"抖动型"卡顿有效，对"带宽 < 码率"型无效）。
- **B**：用户提供一台**港/韩 VPS**（或我写好一键部署脚本），做 **"韩国取流 + 低码率转码"** 完整链路（唯一能真正救被地域封锁的台）。
- **C**：先不动手，把 **A 的收益上限**讲清楚再决定。
- **D（v0.3.3 收尾可选项）**：把实测长期 dead 的韩台（EBS 2/English/Kids/Plus1/Plus2、YTN、TBS、Channel A、国会台、Gugak、MTN、KCTV、NBS、RTV 等）从列表清掉，只留能播的，界面更干净。

## 九、已清理的临时文件（累计）
前批：`remove_indian.py`、`remove_hldtv.py`、`server.js.bak`、`diag.py`、`nettest.py/.out`、`test_kr_sources.py`、`kr_test_result.txt`、`fast_test.py`、`kr_fast.txt`、`cand_test.py`、`cand_result.txt`、`kr.m3u`、`cmp.py`
本批：`cand_movies.m3u`、`cand_kr.m3u`、`cand_eng.m3u`、`cand_freetv.m3u`、`kr_result.txt`、`movie_result.txt`、`kr_extra.m3u`、`kr_extra_result.txt`、`merge_kr_extra.py`、`remove_movies.py`、`probe_cand.py`、`gh_get.py`、`add_channels.py`、`verify.py`、`retest.m3u`、`retest_result.txt`、`gh_skylover*.m3u`、`gh_jhc.m3u`、`tree_*.json`
**保留的可复用工具**：`tools/probe_sources.py`（批量实测 m3u 源 + 假直播识别）。

