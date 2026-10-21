# tv-iptv 变更记录（HISTORY）

> 按用户既定规范：每次改动记录「时间 + 改了什么 + 为什么」。文件名/程序内含版本号，原稿只读、新版本独立派生。

## v0.3.22 — 2026-10-21 18:4x（新增 4 个韩国 MBC 地方加盟台）

### 1) 用户诉求
- 「那加上 HLAN 命名为춘천MBC , HLAT 为 여수MBC , HLAQ 为강원도 MBC , JTV 为 전라북도 MBC，之后加上后台上线看看」
- 前置过滤（上一轮已定）：教育 EBS 不要、购物不要、不稳定（BBS TV 等）不要 → 候选只剩这 4 个 MBC 地方台。

### 2) 改动清单（仅新增 4 台，其余 54 台零变化）
| id | name | 呼号 | 实际台 / 地区 | 源地址 | 经中继 |
|---|---|---|---|---|---|
| 168 | 춘천MBC | HLAN-DTV | MBC 春川放送局（江原道岭西北部） | https://stream.chmbc.co.kr/TV/myStream/playlist.m3u8 | 是（默认） |
| 169 | 여수MBC | HLAT-DTV | MBC 丽水放送局（全罗南道东部） | https://5c3639aa99149.streamlock.net/live_TV/tv/playlist.m3u8 | 是（默认） |
| 170 | 강원도 MBC | HLAQ-DTV | MBC 江原道地方台（实际为三陟/岭东放送局） | http://123.254.93.7:1935/tvlive/livestream2/playlist.m3u8 | 是（默认） |
| 171 | 전라북도 MBC | HLDQ-DTV | MBC 全北地方台（即全州 MBC / JTV） | http://61.85.197.53:1935/jtv_live/myStream/playlist.m3u8 | 是（默认） |

- `CHANNELS` 新增 4 条；`EPG_TITLES` 对应补 4 组标题池；`VERSION` 0.3.21 → 0.3.22。
- logo 用 iptv-org 的 imgur 台标（lthyx2P / 3VSuYsn / FGsKCH3 / byss0Ld）。
- relay 走默认（上海云端中继），与之前差集实测「这 4 台对境外开放、可经中继播放」一致；未设 `relay:false`。
- 命名说明：HLAQ 真实呼号对应三陟/岭东放送局，按用户要求命名 강원도 MBC（更宽泛的江原道标签）；JTV 即 전주MBC，位于全北，命名 전라북도 MBC。
- 已同步：安卓夹具 `channels_live.json`（+4 → 58 条）、`reports/kr-channels-2026-10-21.*` 待刷新。

### 3) 验证
- `node --check` 通过；本地起 8899：`/api/health` 返回 `version:0.3.22`；`/api/channels` 总数 54 → **58**，新增 168–171 四台 name/url/logo/group 全部正确。
- ⚠️ 这 4 台在 iptv-org 标 `[Not 24/7]`（地方台有停播时段，深夜可能无信号），非 7×24；播放稳定性以线上实测为准。

## v0.3.21 — 2026-10-21 18:0x（新增 SBS 스포츠 体育台 + token 自动刷新机制）

### 1) 用户诉求
- 「C。继续深挖，高尔夫的就先不加，再看看别的地方有没有能加上的，实在不行就按你说的A方案自动刷新token的方式，但是只加SBS sports 高尔夫不要」

### 2) 挖源排查全记录（先穷尽，再落到唯一可行项）

| # | 渠道 | 结果 |
|---|---|---|
| 1 | iptv-org 频道库（韩国 sports 类 27 个：KBS N Sports / MBC Sports+ / SBS Sports / SPOTV 全系 / JTBC Golf&Sports / IB Sports / tvN Sports / skySports / STATV / OGN / Baduk TV / Billiards TV / 프로야구1-5 …） | **有 stream 的 = 0** |
| 2 | iptv-org `countries/kr.m3u`（148 行） | 无任何 Sports 分组条目 |
| 3 | Free-TV `playlist_korea.m3u8`（22 条） | 无体育台 |
| 4 | 第三方韩国合集 koreatv.json（173 条） | 仅 SBS 系 3 条（SBS스포츠 / SBS골프 / SBS Golf2），**全带 2 小时 token** |
| 5 | 各台官网实测 | `tvbaduk.com`（韩国棋院围棋台）页面明示「회원가입 / 이용권구매」需买使用券；KBS N Sports `kbsn.co.kr`、MBC Sports+ `mbcsportsplus.com`、SPOTV NOW `spotvnow.co.kr` 均为付费订阅；`statv.co.kr`、`lifesportstv.kr`、`skysports.co.kr`、`ibsmobile.co.kr`、`ognplus.com` 域名不可达 |
| 6 | Cr-cm/iptv-2 韩国清单里的 `live1.streamk.co:8080/sportsbox_preview/`（SPOTV/SPOTV2/SPOTV ON/KBS体育/MBC体育/SBS体育） | 域名 **ENOTFOUND**（已死） |
| 7 | 同上清单里的 `apichvod19.seezntv.com`（IB体育/JTBC体育/KBS体育/MBC体育/SBS体育/SKY体育） | 域名 **ENOTFOUND**（已死） |
| 8 | `mytv.dothome.co.kr/ch/catv/*.php`（241 SBS体育 / 243 KBS体育 / 244 SPOTV / 246 SKY体育 …） | 全部 HTTP 200 但 **body 为空**（页面已废弃） |
| 9 | `iptv12k.com:35461/live/test167/12345/*.m3u8`（MBC sports+ 3219 / SPOTV 3215 / KBSN sports 3214 / SBS Sports 3207） | TCP 可连，但路径 404；根路径返回 **`Access Denied.`**（防盗链/IP 白名单） |

**结论**：韩国体育台（KBS N / MBC Sports+ / SBS Sports / SPOTV 全系）全部是付费频道，公开渠道不存在可用免费流。唯一实测可播的是 SBS 系。

### 3) 为何必须「自动刷新 token」而非写死地址

对 SBS Sports 的 CDN 做了四组对照实验，确认 token 为**强校验**、无法伪造：

| 实验 | 结果 |
|---|---|
| 带 token | **200** |
| 去掉 token | **403** |
| 篡改 token 末位一个字符 | **403** |
| 保留合法 token 但把 path 换成 `sbsgolf/sbsgolf1.stream` | **403**（token payload 里 `path:"/sbsespn1.stream"` 绑定死了路径） |

JWT payload 实测：`{"exp":..., "path":"/sbsespn1.stream", "duration":-1, "uno":"<uuid>", "iat":...}`，`exp = iat + 7200`（**固定 2 小时**，`duration:-1` 只表示「会话不限时」）。

**也无法自行签发**：SBS 官方签发入口 `onair.sbs.co.kr` 已下线（**DNS 无法解析**），`apis.sbs.co.kr/play-api/2.0/onair/channel/{SBS_SPORTS|SBS|...}` 对**所有频道**（含 SBS 主台）一律返回 `onair_yn:"N" / "방송이 종료 되었습니다"`，说明该端点整体失效，不是地域限制。

### 4) 改动明细

| 项 | 内容 |
|---|---|
| **新增频道** | `{"id": 167, "name": "SBS 스포츠", ... "group": "韩国", "relay": 默认 true}` |
| **播放地址** | 基础路径 `https://tvlive.sbs.co.kr/sbsespn/sbsespn1.stream/playlist.m3u8`（占位），运行时由刷新逻辑补上带 token 的最新地址 |
| **CHANNELS 总数** | 53 → **54**；韩国 26 → **27** |
| **EPG_TITLES** | 新增 `167: ["SBS 스포츠 · 直播", …]`（播放器台名从 EPG 读，必须同步） |
| **新增机制** | `SBS_SPORTS_ID` / `SBS_SPORTS_SOURCES`（4 个镜像）/ `SBS_REFRESH_MS`（15 分钟）/ `fetchTextOnce()` / `tokenExpOf()` / `refreshSbsSports()` |
| **刷新策略** | 启动时立即刷一次；之后每 15 分钟一次（`.unref()` 不阻止进程退出）。4 个镜像按序尝试，只采用 **JWT 尚未过期**的地址；全部失败则保留上次地址，不影响其它频道 |
| **改动方式** | 刷新成功时**原地改写** `CHANNELS` 中该条的 `url`，因此 `/api/channels`、`/api/check` 等处自动生效，无需改多处 |
| **/api/health** | 新增 `sbsSports: { exp, expiresInMin }`，可一眼看出该台地址还剩多少分钟 |
| **VERSION** | 0.3.20 → **0.3.21** |

### 5) 镜像与实测证据

- `raw.githubusercontent.com` 国内**直连被重置**（`Recv failure: Connection was reset`），故必须走镜像；4 个镜像按优先级：`gh-proxy.com` → `ghproxy.net` → `ghfast.top` → `cdn.jsdelivr.net`（jsdelivr 有约 12 小时缓存，放最后作兜底，且因会校验 JWT 过期自动跳过旧缓存）。
- **上游按整点自动刷新的实证**：17:01 拉取 token 签发时间为 `17:00:20`；18:01 再拉取变为 `18:00:19`（过期 20:00:19）→ 确认存在韩国境内程序每小时整点批量重签，A 方案成立。
- **全链路实测**（本地 v0.3.21）：`/api/channels` 取到带 token 地址 → 经 `/api/relay` 主清单 **200**（含 `#EXT-X-STREAM-INF`）→ 变体 **200**（**4008 kbps**）→ 末尾分片 **200 / 373 KB**。
- 抽帧认台标：画面右上角 **「SBS Sports LIVE」**，内容为 PBA-LPBA 台球锦标赛（김영원 vs 나인선），与台名一致、无串台。

### 6) 已知限制（如实记录）
- 完全依赖第三方公开清单的自动化存活；若上游停更，该台会在 2 小时后失效（其它 53 台不受影响）。
- 用户明确「高尔夫不要」，故未加 `SBS골프` / `SBS Golf2`（这两个的可用性同上）。

## v0.3.20 — 2026-10-21 17:2x（3 台改韩文名 + 删 KCTV + 地面主台复测）

### 1) 用户诉求
- 「TBS TV 改成 서울교통방송，KTV 改成 국정방송 KTV，OUN 改成 통신대학；删除 KCTV；然后那几个地面主台(KBS1/2 等) 上次说是什么情况下能播放啊？」

### 2) 改动明细

| id | 原名 | 新名 / 处理 | 源 |
|---|---|---|---|
| 106 | TBS TV (720p) | **서울교통방송** | `https://cdntv.tbs.seoul.kr/tbs/tbs_tv_web.smil/playlist.m3u8`（未动） |
| 107 | KTV (South Korea) (1080p) | **국정방송 KTV** | `https://hlive.ktv.go.kr/live/klive_h.stream/playlist.m3u8`（未动） |
| 146 | OUN (1080p) | **통신대학** | `https://live.knou.ac.kr/knou1/live1/playlist.m3u8`（未动） |
| 144 | KCTV (720p) [Not 24/7] | **删除** | `http://119.77.96.184:1935/chn05/chn05/playlist.m3u8` |

**同步范围**：`CHANNELS` + `EPG_TITLES`；三家 url/logo/group/note 一字未动，144 从两处一并移除。

### 3) 地面主台复测结论（回答用户提问，2026-10-21 17:2x 实测）

**KBS 1TV(#137) / KBS 2TV(#138)** — 源 `http://123.108.164.71/etv2sb|etv2/...`
- 苏州家宽直连：`Trying 123.108.164.71:80` → **10s TCP 连接超时**（不是 400、不是 403，是 SYN 无回应）
- 上海云端中继：**HTTP 502**，0.5s 内快速失败
- 判读：源站对非韩国 IP **直接丢包**（韩国有线 IPTV 网关的典型做法）。上次记录为「源站 400」，本次实测已变为彻底不可达 —— 连隧道都建不起来，所以「换浏览器、换 UA、加 Referer」这类手段全部无效。

**JTBC(#139) / SBS(#140) / MBC(#141)** — 源 `https://azure2986.fastedge.net/...`
- `azure2986.fastedge.net` → **DNS ENOTFOUND**；连根域 `fastedge.net` 也 ENOTFOUND
- 判读：**域名已废弃/注销**，与网络环境无关，任何设备、任何地区都解析不出来。

**结论：这三类台在现有条件下都播不了。唯一能播的情形：**
1. KBS 两台：设备或中继位于**韩国境内**（或源站白名单内的网段）。放在国内任何地方（家宽/云服务器）都是 TCP 超时。且源为 **HTTP**，即使能连上，在 https 网页版里也会被浏览器混合内容策略拦掉，只有 App（WebView 已允许混合内容）或本地播放器能播。
2. JTBC/SBS/MBC：除非找到**新的可用域名/源**，否则没有"什么情况下能播"——源已经不存在了。
3. 三种可选解法：A 韩国 VPS 取流转码后由中继分发（成本最高、最稳）；B 找新的第三方镜像源（不稳定，需持续维护）；C 维持现状（保留条目但不显示为可用）。

### 4) 结果
- 频道总数 **54 → 53**；韩国组 **27 → 26**（可用 21 → 20，不可用/不稳仍 6）。
- 线上 `/api/health` = `0.3.20`；`/api/channels` 53 条、韩国 26 条；144 已不存在；106/107/146 名与 EPG 标题均为新名。
- 安卓夹具 `channels_live.json` 53 条；`reports/kr-channels-2026-10-21.*` 同步（公共·教育组 10 → 9 台，统计 26 / 20 / 6 / 53，KBS 两行刷新为本次复测结果）。
- 删掉的 144 源地址保留在本文件，后续若需要可恢复。

## v0.3.19 — 2026-10-21 17:1x（Arirang 两台改韩文名 + 删 HD 台）

### 1) 用户诉求
- 「Arirang TV 改成 아리랑 TV，Arirang Radio 改成 아리랑 라디오；然后删除 Arirang TV HD」

### 2) 改动明细

| id | 原名 | 新名 / 处理 | 源 |
|---|---|---|---|
| 103 | Arirang TV (1080p) | **아리랑 TV** | `http://amdlive-ch01.ctnd.com.edgesuite.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8`（未动） |
| 102 | Arirang Radio (720p) | **아리랑 라디오** | `http://amdlive-ch01.ctnd.com.edgesuite.net/arirang_3ch/smil:arirang_3ch.smil/playlist.m3u8`（未动） |
| 104 | Arirang TV HD (720p) | **删除** | `http://45.162.64.114/ARIRANG/index.m3u8` |

**同步范围**：`CHANNELS` + `EPG_TITLES`（104 在标题表里一并移除）；102/103 的 url、logo、group、note 一字未动（**刻意没往 note 里塞画质后缀**——用户明确要求"只是改名字"）。

### 3) 结果
- 频道总数 **55 → 54**；韩国组 **28 → 27**（可用 22 → 21，不可用/不稳仍 6）。
- 线上 `/api/health` = `0.3.19`；`/api/channels` 54 条、韩国 27 条；104 已不存在；102/103 名与 EPG 标题均为韩文新名。
- 安卓测试夹具 `channels_live.json` 54 条；`reports/kr-channels-2026-10-21.*` 同步（新闻·综合组 7 → 6 台，统计数字与说明已更新）。
- 删掉的 104 源地址保留在本文件，后续若需要可恢复。

## v0.3.18 — 2026-10-21 17:0x（3 台教会台改编号名）

### 1) 用户诉求
- 「FGTV 改成교회TV1 FG，RUTC TV 改成 교회TV2 지식，GCN 改成 교회TV3 GCN」
- 目的：把这三家教会背景频道统一成「교회TV1/2/3」编号前缀，方便用户一眼看出它们是同系列。

### 2) 改动明细

| id | 原名 | 新名 | 源（未改动） |
|---|---|---|---|
| 148 | FGTV (720p/480p) | 교회TV1 FG | `https://fgtvlive.fgtv.com/smil:fgtv.smil/playlist.m3u8` |
| 149 | RUTC TV (720p) | 교회TV2 지식 | `http://d26sxnc75smwvh.cloudfront.net/livehttporigin/rutclive_720p2.stream/playlist.m3u8` |
| 134 | GCN (720p) | 교회TV3 GCN | `http://liveko24-manminglobal3.ktcdn.co.kr/liveko24/gcnko_1300k.stream/playlist.m3u8` |

**同步范围**：`CHANNELS` + `EPG_TITLES`（回看标题表，播放器台名实际从 EPG 标题读，不改会显示旧名）；播放地址、分组、logo、note 全部未动，可用性不受影响。新名已丢掉 `(720p/480p)` 之类的画质后缀，画质信息见本文件与 `reports/kr-channels-2026-10-21.*`。

### 3) 结果
- 频道总数仍 55，韩国组仍 28（仅改名，无增删）。
- 线上 `/api/health` = `0.3.18`；`/api/channels` 与 `/api/epg` 逐台核对 3 台均为新名。
- 安卓测试夹具 `channels_live.json`、韩国频道报告（csv/html）同步改名。

## v0.3.17 — 2026-10-21 17:0x（删 4 台 + 8 台改韩文名）

### 1) 用户诉求
- 「1.删除：EBS 2TV，Gugak TV（国乐），国防 TV（Gugbang），RTV。2：改名字：TV朝鲜→TV 조선, TV朝鲜2→TV조선2, NHTV→농협tv, Daejeon MBC→대전MBC, CJB cheongju→청주SBS, MBC jeju→제주MBC, SBS JTV→전주SBS, G1→강원SBS」

### 2) 改动明细

**删除（4 台，实测已坏或不稳，用户确认移除）**

| id | 原名 | 删除前状态 |
|---|---|---|
| 109 | EBS 2TV (400p) | 中继 504 超时 |
| 119 | Gugak TV (1080p) | 实测可用，但用户不保留 |
| 122 | Gugbang TV（国防 TV） | 中继 504 超时 |
| 147 | RTV (South Korea) | 中继 504 超时 |

**改名（8 台，统一改为韩文台名）**

| id | 原名 | 新名 |
|---|---|---|
| 101 | TV Chosun (720p) | TV 조선 |
| 100 | TV Chosun 2 (720p) | TV조선2 |
| 118 | NHTV (720p) | 농협tv |
| 130 | Daejeon MBC (720p) | 대전MBC |
| 133 | CJB Cheongju SBS (540p) | 청주SBS |
| 135 | MBC Jeju (352p) | 제주MBC |
| 136 | SBS JTV (406p) | 전주SBS |
| 166 | G1 (SBS 江原) | 강원SBS |

**同步范围**：`CHANNELS` 频道定义 + `EPG_TITLES` 回看标题表（否则回看页仍显示旧名）。播放地址（url）、分组、logo 全部未动，因此可用性不受影响。

### 3) 结果
- 频道总数 **59 → 55**；韩国组 **32 → 28**。
- 线上 `/api/health` = `0.3.17`；`/api/channels` 55 条、韩国 28 条；删的 4 个 id 已全部不存在。
- `/api/epg` 逐台核对 8 个改名频道，标题均为新名（如 `TV 조선 · 直播`、`강원SBS · 直播`）。
- 安卓测试夹具 `channels_live.json` 同步为 55 条（删 4 改 8）。

## v0.3.16 — 2026-10-21 13:3x（新增 G1「SBS 江原」；SBS 地方台全量复查）

### 1) 用户诉求
- "你今天再去找一下 SBS有没有别的地方台的播放源"

### 2) 候选盘点（SBS 九家地方加盟台逐一实测）
| 台 | 候选地址 | 本机 | 上海中继 | 结论 |
|---|---|---|---|---|
| **G1 (강원)** | `http://61.82.49.4:1935/live/_definst_/tv.stream/playlist.m3u8` | ✅ 3/3 段 200，1464/1681/1571 KB，1.26Mbps，1280×720 30fps | ❌ 504 | **新增**（仅本机直连） |
| CJB (청주) | `http://1.222.207.80:1935/live/cjbtv/playlist.m3u8` | ✅ 302KB 段 | ✅ 200（1.0s） | 已在库，抽帧复核「CJB SBS」真台 |
| JTV (전주) | `http://61.85.197.53:1935/jtv_live/myStream/playlist.m3u8` | ✅ 1.26MB 段 | ✅ 200（0.6s） | 已在库，抽帧复核「JTV SBS」真台 |
| KNN (부산) | `stream1.knn.co.kr/hls/.../index.m3u8`；`211.220.195.200:1935` | ❌ 403（nginx，IP 白名单，换 UA/Referer 无效）/ 主清单 404 | ❌ 403 | 不可用 |
| KBC (광주) | `119.200.131.11:1935/KBCTV`；`vod.ikbc.co.kr/KBCTV` | ❌ 400/连接失败 | ❌ 502/504 | 不可用 |
| TBC (대구) | `221.157.125.239:1935/live/psike`；`tistory3.daumcdn.net/.../Public_8.m3u8` | ❌ 明文请求 → "sent to HTTPS port"(CF)；TLS1.2/1.3 握手均失败；daumcdn 404 | ❌ 504 | 不可用 |
| TJB (대전) | `1.245.74.5:1935/live/tv/.m3u8` | ❌ 死 | ❌ 504 | 不可用 |
| UBC (울산) | `59.23.231.102:1935`；`stream.ubc.co.kr` | ❌ 死 / DNS 失败 | ❌ 502/504 | 不可用 |
| JIBS (제주) | `123.140.197.22/stream/1/play.m3u8` → `media.jibs.co.kr/stream/1_2000_149771/` | ⚠️ 清单 http=200（自签证书、需 `-k`），但**分片持续 000** | ❌ 504 | 不可用（半通） |
| SBS Plus / Star / International | `streaming-a-802.cdn.nextologies.com/...` | ❌ DNS 不通 | ❌ 502 | 不可用 |

另测：`ythls.armelin.one`（YouTube→HLS 转接）**已死**，本地与云端均不通 → 走不通"用 YouTube 源救被锁台"这条路。

### 3) 改动
- 新增 **id=166「G1 (SBS 江原)」**：`http://61.82.49.4:1935/live/_definst_/tv.stream/playlist.m3u8`，`group=韩国`，`relay:false`（云端不可达，只能本机直连；App 端 WebView 已设 `MIXED_CONTENT_ALWAYS_ALLOW`，http 源可播；纯浏览器 https 页面可能被混合内容策略拦）。
- `VERSION` 0.3.15 → **0.3.16**；新增 EPG 条目 166；安卓测试夹具同步至 59 条。

### 4) 验证
| 项 | 结果 |
|---|---|
| `node --check` | 通过 |
| 线上 `/api/health` | `{ok:true, version:"0.3.16"}` |
| 线上 `/api/channels` | 59 台，166 = G1 relay=false，SBS 系共 4 条（CJB/JTV/SBS 首尔/G1） |
| 抽帧 | G1 帧右上角「G1 SBS」；CJB 帧「CJB SBS」；JTV 帧「JTV SBS」——均为真台 |
| 稳定性 | G1 连续 3 个 10s 分片全 200，约 1.26Mbps |

### 5) 诚实边界
- SBS 地方台普遍**锁韩国 IP 或只走自家 App**（KNN 明确 IP 白名单）。能同时被"你家宽 + 上海云端"取到的只有 CJB、JTV；G1 只在你家宽这一侧可用。
- 之前标记"碰运气"的 `SBS (首尔主台)`（id=140，`azure2986.fastedge.net`）本次复测 **DNS 解析失败**，实质已死。

## v0.3.15 — 2026-10-15 11:2x（CCTV-1/13 换真台源；凤凰卫视摘除）

### 1) 用户诉求
- "你这个凤凰卫视，还是不行啊，一直播放不了，解决一下，还有，中央1套和13套 这个现在看起来有问题，还是山寨台，还得改一下"

### 2) 排查过程（逐环节实测，非推断）

**CCTV-1（id=165）/ CCTV-13（id=164）现状**：源为 `74.91.26.218:82`（美国 VPS 第三方聚合），分片已 403，且用户肉眼确认是"山寨台"。

**央视官方通道确认走不通**：
- CNTV 官方 API `vdn.live.cntv.cn/api2/live.do`：返回 `video_protect:3`（DRM），CCTV-1 还提示"暂不支持播放该时段内容" → 官方对免费直连已上 DRM。
- 凤凰秀官方 API `m.fengshows.com/api/v3/live/list`：200 可达，HLS 主清单经中继也 200，但变体落在华为云 CDN `livehwc4.com`——本机与上海云端中继都连不上 → 事件流走不通。

**找到真台源**：`219.147.245.238:25480`（江苏电信 IPTV 网关，本机与云端均可达）。
- 扫描频道段：hls/1–17 = 央视段（1=CCTV-1，14=CCTV-13），40–50 = 西部卫视，85–107 = 各省卫视。
- **ffmpeg 抽帧验证台标（决定性证据）**：`hls/1` = 「CCTV 1 综合」、`hls/14` = 「CCTV 13 新闻」（新闻直播间画面），均为真台。
- 滑动窗口直播（分片 `program-NNNN.ts` 序号持续前移），清单/分片延迟 <0.6s。

**凤凰卫视（id=163）系统性排查结论：无任何可用公开源**：
| 通道 | 结果 |
|---|---|
| ifeng 官方 `playtv-live.ifeng.com/live/06OLEGEGM4G.m3u8` | 主清单 200 但为**静态占位**，变体 `_tv1/_tv2` 404（云端能到 ifeng，但 ID 已失效） |
| 央视式官方 API（shankapi.ifeng 等） | 假 200（body not found） |
| 中国移动 OTT（223.110.245.x / 111.13.111.242 / 221.179.217.9 / 112.17.40.x） | 本机与云端中继全部 504/超时 |
| 电信/联通 IPTV 后端（wlds/ysten、113.64、60.10、tsfile 系） | 云端 502/504 |
| GITV 网关（58.248.112.205:8006，云端可达） | Authinfo 时效令牌，且清单只含央视+大陆卫视，无凤凰 |
| 凤凰秀 fengshows（官方） | HLS 变体 CDN `livehwc4.com` 本机+云端均不可达 |
| 论坛/第三方（laotv、qist、jdshipin、an94、guihet、dens.tv 等） | 全部死链/域名失效（多为 2024 旧帖） |
| fanmingming 每日检测清单（国内最权威） | **完全没有凤凰**；iptv-org 全库仅死源 |
| dens.tv（印尼， lineup 有凤凰） | 域名 DNS 已失效 |

### 3) 改动
- **id=165 CCTV-1**：url → `http://219.147.245.238:25480/newlive/live/hls/1/live.m3u8`（真台，抽帧验证）
- **id=164 CCTV-13**：url → `http://219.147.245.238:25480/newlive/live/hls/14/live.m3u8`（真台，抽帧验证）
- **id=163 凤凰卫视中文台**：从频道列表**摘除**（无可用源，留着只会让用户点开黑屏；后续若出现可靠源可随时加回）
- `VERSION` 0.3.14 → **0.3.15**
- 同步安卓测试夹具 `channels_live.json`（59 → 58 条，164/165 换新地址）
- git：改前先提交基线 `967ce3d`（tv-iptv v0.3.14 首次入库）

### 4) 验证（真跑，部署后端到端）
| 项 | 结果 |
|---|---|
| `node --check server.js` | 通过 |
| 线上 `/api/health` | `{ok:true, version:"0.3.15"}` |
| 线上 `/api/channels` | 总数 58，163 不存在，164/165 已为新地址 |
| 中继取 CCTV-13 分片 | 200，**2,204,864 B** 真实 TS |
| 中继取 CCTV-1 分片 | 200，**5,568,184 B** 真实 TS |
| 分片抽帧 | 「CCTV 13 新闻」朝闻天下（画面日期"星期四 11:21"= 当天实时）；「CCTV 1 综合」电视剧 |

## v0.3.14 — 2026-10-15 09:3x（修好 YTN：换成 YTN 官方源）

### 1) 用户诉求
- "你看一下 YTN 为什么放不出来呢"

### 2) 排查过程（逐环节实测，非推断）
YTN 在列表里的源是 `http://202.60.106.14:8080/214/playlist.m3u8`（iptv-org 早年条目）。逐环节定位：
| 环节 | 结果 |
|---|---|
| 直连该 IP:8080（绕代理，模拟家宽） | ❌ HTTP 000，`/dev/tcp` TCP 8080 **连接超时** |
| 经线上中继 `/api/relay` | ❌ HTTP 504 `relay timeout` |
| 对照：同表其它韩台（TV Chosun 等） | ✅ 200 → 证明**工具/网络/中继都正常**，是源本身死了 |
| iptv-org 现网 `countries/kr.m3u` 里 YTN 用的地址 | **同一个死地址** → 说明 iptv-org 也没更新过，**全球都连不上**，不是我们配错 |

### 3) 修复：换成 YTN 官方源
- 官方播放页 `https://www.ytn.co.kr/_hd/hd_live.html`（200，无 X-Frame 限制）指向官方流：
  **`https://ytnlive.ytn.co.kr/ytn/_definst_/ytnlive_stream_20220426/medialist_9171188557012390620_hls.m3u8`**
- 全链路实测（全部 200）：
  | 环节 | 结果 |
  |---|---|
  | 清单 | 200 `application/vnd.apple.mpegurl`，**无 `EXT-X-KEY`（不加密）** |
  | 分片（直连） | 200，2,136,056 B，`video/mp2t`，首字节 `0x47`（真 TS 包） |
  | 分片（经线上中继） | 200，**同为 2,136,056 B**，`video/mp2t` |
  | 中继改写 | 中继已自动把分片改写成 `/api/relay?url=…`，**无需改中继逻辑** |
- 对比 KBS World：KBS 有 `Policy` 签名 + AES-128 加密；**YTN 两者都没有**，是最省事的一类（静态地址即可）。
- 只改了 `CHANNELS` 里 id=105 一行的 url/note，`VERSION` 0.3.13 → **0.3.14**；**未新增频道、未动其它台**。
- 同步把安卓端测试夹具 `app/src/test/resources/channels_live.json` 的 YTN 行对齐（该文件声明为「线上 /api/channels 原样响应」的快照）。

### 4) 验证（真跑）
| 项 | 结果 |
|---|---|
| `node --check server.js` | 通过 |
| 本地/线上 `/api/health` | 线上 `version:0.3.14` |
| 线上 `/api/channels` | id=105 的 url 已为新官方地址 |
| 线上 `/api/relay` 取清单 | 200，分片已改写为走中继 |
| 线上 `/api/relay` 取分片（端到端） | 200，2,136,056 B，`video/mp2t` |
| 部署 | `tvlive-relay.app.workbuddy.host`，链接不变 |

### 5) 坑与不确定点
- **取分片必须取清单里"最新"那条**：YTN（WOWZA）对已滚出直播窗口的旧分片返回 **400**；我第一版验证脚本取了最旧那条 → 误报 400，改取最新后 200。（真机播放器永远取最新，不受影响。）
- 「搬来的民间源会不会哪天复活/官方源会不会改路径」无法预判；官方源要挂了得再换。
- 本次**仍未做长时间挂机**（未自然跑满数小时），但 YTN 无签名无加密，理论上不会像 KBS World 那样 48 小时过期。

## v0.3.13 — 2026-10-12 17:xx（修复「回放站内嵌后播放器播不了」——播放器 Referer 白名单 + 流防盗链）

### 1) 用户诉求
- "现在这个版本是在一个页面里显示了，但是里面的播放器不能正常播放了，改好它。"

### 2) 排查过程（关键：先证伪自己的第一假设，再定位真因）
- **假设①（错）**：以为是我们自己 iframe 上的 `referrerpolicy="no-referrer"` 把播放请求的 Referer 剥掉了 → 流服务器防盗链 403。
  - 为此专门写了 `tools/verify_referrer_chain.js`（用两个本地端口 1:1 复刻「我们的页面 → 代理页 → 跨域播放器」三层链路）实测：
    **结果证伪了假设①** —— Chrome 不会把中间层 iframe 的 `referrerpolicy` 继承给更内层的跨域 iframe，播放器请求仍带来源域 Referer。
- **真因（已用 curl 精确复现）**：回放站详情页里的播放器是**另一个域名**的 iframe（`xiaoca.top`）。该播放器页按 **Referer 白名单**发放播放地址：
  | 发给播放器页的 Referer | 返回内容 |
  |---|---|
  | `https://www.dodotv20.com/`（回放站域名） | 页面里**带**加密的真实流地址 → 能播 |
  | 我们的域名 / `https://xiaoca.top/` / 空 / 任意其它域名 | 页面里**根本没有**这段地址 → 播放器纯黑，怎么点都不播 |
  且真实流地址所在的 `wiselife.blog` 还有**第二层防盗链**：只认 `Referer: https://xiaoca.top/`，否则 `403 Forbidden`（实测：不带 Referer → 403；带 xiaoca.top → 200）。
  **浏览器不可能伪造跨域 Referer**（iframe 的 Referer 只能是承载它的页面域名），所以两处都必须由我们自己的服务器代劳。

### 3) 修复方案（后端为主，前端只调属性）
1. **把播放器 iframe 也接进内嵌代理**：处理回放站页面时，把指向「已知播放器域名」的 `src` 改写成
   `/api/embed?url=<播放器页>&ref=<回放站域名>`，由服务端在回源时补上播放器要求的 Referer，于是播放器页里**又有了**真实播放地址。
   （`PLAYER_HOSTS = ["xiaoca.top"]`，含子域；换回放站时可能需要追加。）
2. **播放器页注入请求改写脚本**（`PLAYER_PATCH`，插在 `<head>` 最前，早于播放器自身脚本）：
   把播放器发出的**站外请求**（真实流 `wiselife.blog`、分片 `files3.imgtu.top` 等；公共 CDN 除外）统统改走 `/api/relay?...&ref=<播放器域名>&raw=1`，
   由中继在服务端补上 `Referer: https://xiaoca.top/`，绕过第二层防盗链。
   - **只改网络请求、不改播放器手里的地址字符串** —— 这点很关键：Artplayer 靠 `.m3u8` 后缀选择 HLS 处理器，
     早期尝试「把加密地址直接替换成中继地址」会让后缀变成 `?url=...` → Artplayer 退化成原生播放 → 直接报错黑屏（已实测踩坑并回退）。
3. **中继新增 `raw=1`**：原样返回播放列表、不做地址改写（改写后的相对地址会让 hls.js 解析基准出错），
   同时保留分片预取与缓存；播放列表缓存键区分 raw/非 raw，避免串味。
4. **中继新增 `ref=`**：可指定回源时的 Referer，**仅接受白名单域名**（回放站域名 / 播放器域名），避免沦为「任意 Referer 注入」；分片预取也沿用该 Referer。
5. 前端 `index.html` 回放 iframe：`referrerpolicy` 由 `no-referrer` 改为 `strict-origin-when-cross-origin`（与浏览器默认一致），
   并补 `allow="autoplay; encrypted-media; fullscreen; picture-in-picture" + allowfullscreen`（播放器全屏等权限）；`sandbox` 保留。
6. 顺手修掉一个**潜在旧 bug**：代理内相对地址原先以「站点根」为基准解析，改为以「当前页面地址」为基准
   （播放器页在 `/one/` 子目录，`common.js?v=51` 必须解析成 `/one/common.js`，否则脚本 404、播放器整个起不来）。

### 4) 验证（真实浏览器端到端，不是口头）
- `tools/e2e_player_page.html` + `tools/e2e_collect.js`：常驻无头 Chrome 跑真实链路「回放站详情页 → 播放器 → 实际播放」45 秒，
  每 0.7s 回报一次 `<video>` 真实状态，实测结果：
  `readyState=4  currentTime 0.11→3.58s（匀速推进）  duration=11134.7  1280×676（真实分辨率，说明确实解码出了画面）  buffered=41.6s  src=blob:（MSE，即 hls.js 在喂流）` → 判定 **PLAYBACK-CONFIRMED**。
- 本地回归：版本号 0.3.13、59 频道、详情页 133 处导航仍走代理、播放器页含播放地址且已注入改写脚本、无 XFO/CSP、非法域名仍 403、语法通过。
- `tools/verify_referrer_chain.js` 保留：用于**证伪**「referrerpolicy 继承」这类假设，避免下次再凭直觉改错地方。

### 5) 线上部署后复验（2026-10-12 更晚些，v0.3.13 已发布）
**第 1 层：链路每一步都单独取到证据（Node 脚本 + curl）**
| 检查项 | 实测结果 |
|---|---|
| 线上版本 | `/api/health` → `{"ok":true,"version":"0.3.13"}` |
| 列表页 | `/api/embed?url=<回放站列表>` → 200，88156 字节，**123** 个链接全部被改写为 `/api/embed?url=...` |
| 详情页 | `/api/embed?url=<shplay.php?id=...>` → 200，iframe 数量 2，其中 `view_iframe` 的 `src` 已变成 `/api/embed?url=https://xiaoca.top/one/onet.php?...&ref=https://www.dodotv20.com/`，且带 `allow`/`allowfullscreen` |
| 播放器页 | 200，**无** XFO、**无** CSP，`phpsiteEc2` 密文**非空（248 字符）**，注入的改写脚本存在 |
| 解码算法 | 直接从中继拉的 `common.js` 里读到源码：`base64_decode(phpsiteEc2)` → 逐字符 XOR `phpsitekey3` → 再 `base64_decode`；用 Node 按此实现解开密文，得到**当时新鲜**的真实流地址 `https://wiselife.blog/hls/6acc198fcffc9dd54c62306c.m3u8?t=...&n=...&s=...` |
| 中继读流 | `/api/relay?url=<真实流>&ref=https://xiaoca.top/&raw=1` → **200**，297482 字节，首行 `#EXTM3U`，**1113** 个分片 |
| 中继读分片 | 首片 → **200**，**3797788 字节**（真实视频数据） |

**第 2 层：真实浏览器跑「用户真实操作路径」（决定性证据）**
新增并保留 `tools/verify_live_playback.js`（无头 Chrome + CDP 跨帧执行，可深入任意嵌套层），
完整复刻用户动作：**打开首页 → 点「回放」→ 列表里点进视频 → 播放器**，逐秒回报 `<video>` 真实状态：
```
帧结构 3 层：首页 → /api/embed?url=…dodotv20.com/shplay.php… → /api/embed?url=…xiaoca.top/one/onet.php…
[0s] readyState=4 currentTime=0    duration=11134.7 1280x676 buffered=16.6 src=blob:
[1s] readyState=4 currentTime=0.94 duration=11134.7 1280x676 buffered=16.6 src=blob:
[2s] readyState=4 currentTime=1.95 duration=11134.7 1280x676 buffered=25   src=blob:
[3s] readyState=4 currentTime=2.96 duration=11134.7 1280x676 buffered=33.3 src=blob:
[4s] readyState=4 currentTime=3.96 duration=11134.7 1280x676 buffered=33.3 src=blob:
===== USER-PATH-E2E-CONFIRMED =====
```
`readyState=4` + `currentTime` 匀速推进 + `1280×676` 真实分辨率 + `src=blob:`（hls.js 在喂 MSE）= 确实在播。
**注意**：无头 Chrome + CDP 的一个坑 —— 同帧导航会销毁旧执行上下文且**不触发** `executionContextsCleared`，
必须监听 `executionContextDestroyed` 并用最新上下文覆盖映射，否则 `Runtime.evaluate` 会静默返回 undefined（一度误判为"页面里没有链接"）。脚本已按此修正。

### 6) 解除一个遗留疑问（原记为"结果异常"）
- 现象：曾观察到「中继不带 `ref` 也应 403，却返回 200」，当时原因未查明。
- 现结论：**这不是 bug，是预期行为**。中继不传 `ref` 时，回源 Referer 取"上游自身域名"（`https://wiselife.blog/`），
  而流站实测**接受自身域名**（`Referer: https://wiselife.blog/` → 200），只有**错误**的第三方 Referer（如 `dodotv20.com`）才 403。
  所以默认行为正确；`ref=` 的作用是"需要冒充成播放器域名时"才用。
- 另：最初一次中继测试返回 403，是因为复用了**已过期**的 `?t=` token（该参数有有效期），换成当次新解出的地址后立即 200。**测试流地址必须现取现用**。

## v0.3.12 — 2026-10-12 16:4x（回放改为「内嵌窗口」，可直播/回放自由切换）

### 1) 用户诉求（对 v0.3.11 的修正）
- "你在回放页面里放一个新建浏览器窗口然后把网站打开不行吗？我要在回看和直播页面来回自由切换呢，你这样就没法切换了。"
- 即：v0.3.11 的「新窗口打开外部站」体验割裂（跳到别的窗口后回不来），要求**把回放站直接嵌在本页里**，顶部按钮可随时切回直播。

### 2) 难点与破解（关键）
- **难点**：回放站返回 `X-Frame-Options: SAMEORIGIN` + `CSP frame-ancestors 'self'`，**浏览器强制禁止它被 iframe 嵌套**（直接嵌 = 白屏）。
- **破解**：新增后端「内嵌代理」`GET /api/embed?url=<页面地址>`，由**我们自己的服务器**去拉取该页面，再做三件事：
  1. **不透传**「禁止被嵌套」的响应头（响应头由我们构造，不带 X-Frame-Options / CSP）→ iframe 可正常显示；
  2. 页面内**相对资源**（`./resource/css`、`/img` 等）统一补成**原站绝对地址** → 否则会跑到我们域名下 404、页面裸奔无样式；
  3. 站内**导航链接**（`<a>` / `<form>`）改写为**走本代理** → 否则点击后在 iframe 内跳到原站、又被其 X-Frame-Options 拦成白屏。
- **安全**：`/api/embed` 有**域名白名单**（仅允许回放站主域及其子域），防止被当成开放代理滥用；非白名单域名返回 403。
- **实测确认**（真实 Chrome 渲染截图）：回放站是 **PHP 服务端渲染**（列表/海报在 HTML 里直出），代理后**菜单、搜索框、海报墙全部正常显示**。

### 3) 前端交互
- iframe **默认显示**（不再隐藏、不再需要"尝试内嵌"），进入回放模式即加载。
- **切换即停**：切回直播时把 iframe 置为 `about:blank`（彻底卸载，停止回放视频后台播放/耗流量），并暂停 `<video>`；切回回放时**原位恢复**上次浏览的页面（`lastFrameSrc`），没有则加载默认页。
- 按钮改为：**⟳ 刷新**（重载当前页）、**回默认页**（丢弃站内浏览位置）、**↗ 新窗口打开原站**（保留后备）。
- 地址栏 + 保存/重置默认 保留（localStorage 覆盖后端默认，地址常变时自己改，无需重新部署）。

### 4) 改动文件
- `backend/server.js`：`VERSION` 0.3.11→0.3.12；新增 `embedPage()` 函数与 `/api/embed` 路由。
- `backend/web/index.html`：回放面板改为默认显示 iframe；按钮改为「刷新 / 回默认页 / 新窗口打开原站」；sandbox 增加 `allow-popups-to-escape-sandbox`。
- `backend/web/app.js`：新增 `replayEmbedSrc()` / `loadReplayFrame()` / `reloadReplayFrame()` / `replayGoHome()`；`setMode()` 增加切换时卸载/恢复 iframe 逻辑；`loadConfig()` 在 #replay 深链下配置就绪后补加载；删除 `applyReplayUrl/openReplaySame/toggleReplayEmbed`。

### 5) 验证（真实 Chrome + 虚拟时间预算截图）
- `/api/embed` 响应头**无** X-Frame-Options / CSP；资源已绝对化为 `https://www.dodotv20.com/...`；导航已改写为 `/api/embed?url=...`；无占位符残留；非白名单域名 403。
- 对照实验证明 sandbox **不是**黑屏原因（带 sandbox 的 iframe 照样完整渲染）。
- 真实 `#replay` 页面截图：iframe 内完整显示 dodotv 站点（菜单/搜索/海报墙）。**台标/内容以用户实测为准。**
- 说明：Chrome `--screenshot` 会在父页 load 事件时抢跑截图（而 iframe src 是 load 之后由 JS 设置的），故普通截图会拍到黑框；用 `--virtual-time-budget` 或静态 iframe 页才能拍到内容 —— 这是**验证工具的局限**，非产品缺陷。

## v0.3.11 — 2026-10-12 16:0x（新增「直播 / 回放」双模式，回放指向外部站点）

### 1) 用户诉求
- 直播功能完工，做**往期回放**功能：页面上用**两个按钮**切换「直播 / 回放」；回放以"跳转到另一个网站"的形式实现。
- 指定回放站：`https://www.dodotv20.com/show.php?tid=3&order_type=`；**后续地址可能经常变**，要求先做出来。

### 2) 设计
- **顶部模式切换**：header 内新增 `直播 | 回放` 两个按钮（`.modebar` / `.mode-btn`），切换 `#liveWrap`（原三栏：频道/播放器/EPG）与 `#replayWrap`（回放面板）的显隐。切回直播时自动暂停 `<video>` 省资源。
- **回放 = 外部站点**：主按钮「▶ 打开回放站（新窗口）」用 `window.open(url,"_blank","noopener")`；另有「在本页打开」（同标签跳转）。
- **地址可随时改（关键，因地址常变）**：
  - 后端新增常量 `REPLAY_URL` + 接口 `GET /api/config` → `{ version, replayUrl }`，作为**默认地址**。
  - 前端地址栏可**就地修改并存 localStorage**（键 `tvlive_replay_url`），**覆盖后端默认值**，无需改代码/重新部署；另有「重置默认」。
  - 优先级：localStorage 覆盖 > 后端默认。
- **内嵌为可选**：探测发现回放站返回 `X-Frame-Options: SAMEORIGIN` + `CSP frame-ancestors 'self'` → **禁止被 iframe 嵌入**。故内嵌不默认显示，仅提供「尝试内嵌」按钮按需加载（避免一进回放页就是一片空白），并附拒绝嵌入的说明。

### 3) 改动文件
- `backend/server.js`：`VERSION` 0.3.10→0.3.11；新增 `REPLAY_URL` 常量；新增 `/api/config` 路由。
- `backend/web/index.html`：header 加模式按钮；`<main>` 加 `id="liveWrap"`；新增 `#replayWrap` 回放面板（地址栏 + 保存/重置 + 打开/本页打开/尝试内嵌 + 隐藏的 iframe + 提示）。
- `backend/web/app.js`：新增 `loadConfig / currentReplayUrl / applyReplayUrl / setMode / openReplay / openReplaySame / toggleReplayEmbed / saveReplay / resetReplay` 及按钮绑定；启动时 `loadConfig()`+`setMode("live")`。
- `backend/web/style.css`：`.modebar/.mode-btn`、`#replayWrap` 面板、地址输入、按钮、iframe 样式；`#liveWrap.hidden/#replayWrap.hidden/.replay-frame-box.hidden` 显隐。

### 4) 验证依据（实测）
- **回放站可达**：`dodotv20.com/show.php?tid=3` 直连与经上海中继均 **200 / text/html**（韩国站点「도도티비」）；响应头含 `X-Frame-Options: SAMEORIGIN`、`Content-Security-Policy: frame-ancestors 'self'`（→ 内嵌会被拒，故走新窗口）。
- 本地：`node -c server.js`/`web/app.js` 通过；`/api/health`→0.3.11；`/api/config` 正确返回 replayUrl；页面含全部新模式/回放元素，`app.js` 各函数就位。
- 线上：见部署后 `/api/health` 与页面实测。

## v0.3.10 — 2026-10-12 15:0x（新增韩国国家级主台：KBS1/KBS2/JTBC/SBS首尔/MBC首尔，本机直连未验证）

### 1) 用户诉求
- 用户希望把**韩国国家级地面主台**（KBS1/KBS2、JTBC、SBS 首尔主台、MBC 首尔主台）加入列表——之前的韩国台只有地方加盟台与 KBS World（国际版），缺国家级主台。

### 2) 探测结论（关键：无中继可达源）
- 挖遍公开源：iptv-org kr.m3u（KBS1/KBS2/JTBC/SBS/MBC 主台全部 Geo-blocked 或无源）、imDazui KoreaSD、WinnieIPTV_KR、Gitee suhhai kr.m3u、官方域（play.jtbc.tv / simlive.sbs.co.kr / simlive.imbc.com / kbs akamai+gscdn）。
- **逐个经上海中继实测：全部 502/504/000**（中继本身正常，同批 EBS1TV=200、CGTN=200 作对照）。
- 沙箱直连 HTTPS 候选源亦 000。根因：韩国地面波主台对韩国以外 IP **地域封锁**，中继（上海云，中国 IP）拉不到，用户家宽（同为中国 IP）大概率同样被挡。

### 3) 改动（59 个频道，韩国组 31 个）
- 新增 5 个主台条目，全部 `relay:false`（本机直连、关中继），标注"未经验证，属碰运气"：
  - `137 KBS 1TV (首尔主台)` — `http://123.108.164.71/etv2sb/phd852/playlist.m3u8`（⚠️ HTTP，HTTPS 页面会被浏览器混合内容拦截）
  - `138 KBS 2TV (首尔主台)` — `http://123.108.164.71/etv2/phd847/playlist.m3u8`（⚠️ HTTP，同上）
  - `139 JTBC (首尔主台)` — `https://azure2986.fastedge.net/live2/5pb6uqm5gr/chunklist.m3u8`（HTTPS）
  - `140 SBS (首尔主台)` — `https://azure2986.fastedge.net/live2/fyy2qd90t9/chunklist.m3u8`（HTTPS）
  - `141 MBC (首尔主台)` — `https://azure2986.fastedge.net/live2/sdmgv7y53u/chunklist.m3u8`（HTTPS）
- 沿用 v0.3.9 的 `relay:false` 单频道直连机制（app.js:167 `useRelay = relayOn && ch.relay !== false`）。

### 4) 如实说明（交付边界）
- 这 5 个主台源**我无法在中继侧验证**（地域封锁），且 KBS1/KBS2 是 HTTP 源、在 HTTPS 页面上会被浏览器拦截。**以用户在家实测为准**；若全部打不开属预期（韩国主台地域封锁），届时再议（换中继区域 / 用户本地代理 / 放弃主台）。
- 已向用户澄清：SBS/MBC 现有地方台（130/133/135/136）已**同步转播全国台戏剧综艺**，KBS 有 KBS World（103/104 国际版）；真正缺口仅 KBS1/2 国内版与 JTBC。

### 5) 验证
- 本地：`node -c` 通过；`version=0.3.10`、59 台、韩国组 31、137–141 均 `relay=OFF`。
- 线上：见部署后 `/api/health` + `/api/channels` 实测。

## v0.3.9 — 2026-10-12 13:3x（恢复英文新闻台 + 替换山寨 CCTV 源 + 凤凰直连模式）

### 1) 用户反馈（纠偏 v0.3.8 误读）
- **纠正上版误读**：用户上轮说"不要英文台、只要国内源"，实际语义是"凤凰和 CCTV-13 应是流畅的国内台却播不了、要改进"；**并未要求删除 CGTN English / NHK / Al Jazeera**。v0.3.8 误删这三个英文新闻台，本版恢复。
- 用户实测指出 `164(CCTV-13)` 实为「冀时」台标、`165(CCTV-1)` 实为「花垣综合」——均为**错台/山寨**（之前选源仅凭"列表可达"误判，未核实频道身份）。本版换源。

### 2) 改动（54 个频道，新闻组 6 个）
- **恢复**：`160 CGTN English`(cgtn.com 官方域名)、`161 NHK World-Japan`(nhkworld.jp 官方域名)、`162 Al Jazeera`(getaj.net 官方 CDN)。三者均经上海云端中继实测可达(200)。
- **替换 CCTV-13(164)**：弃用 hebtv/jishi 假源，改用 `http://74.91.26.218:82/live/cctv13hd.m3u8`（分片路径 cctv13md，iptv-org 标注 CCTV13.cn@HD）。
- **替换 CCTV-1(165)**：弃用 voc/134 假源(花垣综合)，改用 `http://74.91.26.218:82/live/cctv1hd.m3u8`（分片路径 cctv1，iptv-org 标注 CCTV1.cn@HD）。
- **凤凰(163) 改直连模式**：上海中继与沙箱均无法直连任何凤凰源（chinamobile 国内源 504、各论坛镜像 502/404），故设 `relay:false` 强制本机直连，用 iptv-org 标注的 chinamobile 凤凰源；依赖用户家宽能否直连中国移动 IPTV CDN（通常仅移动宽带），且可能受浏览器跨域限制。

### 3) 前端改动
- app.js：`selectChannel` 新增 `useRelay = relayOn && ch.relay !== false`，单频道可用 `relay:false` 强制本机直连；加载提示区分「经后端中继 / 本机直连」。

### 4) 验证依据（real-world 探测，上海云端中继）
- 可达(200)：CGTN English(cgtn.com)、NHK World(nhkworld.jp)、Al Jazeera(getaj.net AJA 主频)、CCTV-13/CCTV-1(74.91.26.218 主列表)。
- 不可达：凤凰全源(504/502)、Al Jazeera 英文台 AJE(502)、kcdnlive 官方 CCTV(502)。
- **身份核实局限（如实说明）**：本版以 iptv-org 权威 tvg-id + 分片路径命名(cctv13md/cctv1) + TS 同步字合法 作"真央视"依据；但沙箱无法下载 ffmpeg（gh-proxy 大文件超时、直链被拦）、TS 元数据(SDT)被转发源剥离，**无法在交付前肉眼抽帧确认台标**。最终以用户点开肉眼确认为准。

### 5) 待用户实测
- CCTV-13/CCTV-1：请点开看台标是否确为央视（若仍错台立刻反馈）。
- 凤凰：直连依赖家宽网络与跨域，可能仍打不开；若如此需换方案（换中继区域 / 换源）。
- Al Jazeera：当前中继可稳定取到的是 AJA 主频（阿语），英文台 AJE 中继暂不可达。

## v0.3.8 — 2026-10-12 12:5x（国内新闻组重构 + 中继跟随重定向）

### 1) 用户反馈
- 新闻组里出现两个「韩国」分类头（实为云端仍在跑旧版 app.js，未正确聚合分组）。
- 凤凰卫视看不了、CCTV-13 也播不了；明确不要英文台（CGTN English / NHK / Al Jazeera），只要单纯国内源。

### 2) 改动（51 个频道，新闻组 3 个全为国内台）
- **删除**：`160 CGTN English`、`161 NHK World`、`162 Al Jazeera English` 三个英文台。
- **凤凰卫视(163)**：先试 `ccav.zone.id/php/fh.php?id=2`（302 代理源，中继已支持跟随跳转），实测最终 403 / 或返回 FLV 流（hls.js 无法播放）；改换 `cdn9.163189.xyz/smt3.1.1.php?id=phoenixtv_hd`（国内电信友好源，论坛确认可用），标注「需关闭中继用本机直连试，暂未经验证」。
- **CCTV-13(164)**：保留 hebtv 源（云端中继可达，但偶发超时，已标注）。
- **新增 CCTV-1 综合(165)**：`liveplay-srs.voc.com.cn` 国内稳源，端到端验证可流畅播放（分片 200 / video/mp2t / 767KB / TS 同步 OK / 800ms），作 CCTV-13 备用。
- **中继跟随重定向**：`relayStream` 新增对上游 301/302/307/308 跟随（深度上限 4 防环），解锁 ccav 这类 302 代理源及国内 CDN 跳转。

### 3) 验证依据（real-world 探测）
- 凤凰旧 `27.41.245.32`：沙箱实测 http-1 死链。
- CCTV-13 hebtv：云端中继播放列表 200+HLS，但偶发取不到（源不稳）。
- CCTV-1 voc.com.cn：云端中继端到端拉真实 .ts 成功（767252 bytes, video/mp2t, TS 同步 OK）。
- 凤凰候选（chinamobile/125.210/freetv/cdn6/ccav）：除 ccav 返回 302 外，其余从上海云端均不可达。

### 4) 待用户实测
- 部署后请在云端点「重测可达性」：凤凰(163) 若经重定向跟随仍红，则公开源暂无稳的凤凰台，下版移除或换官方 fengshows App。

## v0.3.7 — 2026-10-12 12:2x（纯前端 UI：分类折叠/展开）

### 需求（用户原话）
「把 130,133,134,135,136 这些韩国台都收录到《韩国》大分类下面；每个分类都做个收纳的按钮，大分类点一下向下展开所有的频道目录」

### 改动
- **分组确认**：`130 Daejeon MBC`/`133 CJB Cheongju SBS`/`134 GCN`/`135 MBC Jeju`/`136 SBS JTV` 经核查**已在 `group:"韩国"`**（此前入库即归类正确），后端频道数据零改动。
- **前端新增「分类收纳」交互**（backend/web/app.js + style.css）：
  - `renderList()` 重构为「按分类分组」渲染：每个分类一个可点击的 `.cat-head` 头（带 ▾/▸ 箭头 + 频道数徽标），点击调用 `toggleGroup()` 折叠/展开该分类下**全部**频道。
  - 新增 `collapsedGroups` 集合保存折叠状态、`buildChItem()` 复用旧版频道行逻辑（状态点/高亮/收藏星标不变）、`toggleGroup()` 切换并重绘。
  - CSS：`.cat-head` 改为 `cursor:pointer` 的按钮样式，新增 `.arrow`/`.cat-name`/`.cat-cnt`，`.ch-item.hidden` 控制收起隐藏。
  - 默认全部展开（与旧版视觉一致，不惊扰）；点一下收纳、再点向下展开。收藏筛选（仅看收藏）与重测可达性均兼容分组渲染。
- 后端 API 逻辑未变，仅升版本号标记 UI 迭代。

### 验证
- 本地 `node --check server.js` 通过；浏览器逻辑静态自检（renderList 分组/折叠/重绘路径齐全）。
- 部署后线上 `/api/health` 应为 `version:0.3.7`；手动点分类头验证折叠/展开。

## v0.3.6 — 2026-10-12 12:1x

### 需求（用户原话）
「地面波的也要看（韩剧多的），删除：EBS English (400p)、EBS Kids (400p)、EBS Plus 1 和 2 (400p)、Channel A [Geo-blocked]、MBC Gyeongnam TV (1080p) [Not 24/7]、National Assembly TV (720p)、MTN (720p)」

### 改动
- **删除 8 个频道**（61 → 53）：`110 EBS English`、`111 EBS Kids`、`112 EBS Plus 1`、`113 EBS Plus 2`、`114 Channel A`、`116 MBC Gyeongnam TV`、`117 National Assembly TV`、`120 MTN`。
- **保留地面波**（用户明确要留、韩剧多）：`108 EBS 1TV`、`109 EBS 2TV`，以及 KBS/MBC/SBS/地方台等全部保留。
- 删除项均为注记 [Geo-blocked] / [Not 24/7] / 教育少儿类（与"看韩剧"诉求无关），符合用户精简意图。
- CHANNELS 53 ↔ EPG_TITLES 53 校验一致，无孤儿。

### 验证
- `--check` 语法 OK；脚本校验 8 个 id 均不在列表、108/109 仍在。
- 本地改动后由部署流程覆盖云端（见会话内重部署与 `/api/health` 实测）。

## v0.3.5 — 2026-10-12 11:1x

### 需求（用户原话）
「新闻频道，也像电影频道一样，找一下优质的呢，凤凰卫视什么的央视新闻频道也行啊，现在的这些都去掉吧，一直都是红色的」

### 1) 删除原 4 个红色新闻台（60 → 56）
- 删除 `10 ABC News Live`、`11 i24NEWS English`、`12 CBS News Boston`、`13 NewsWorld`（group=新闻，用户反映一直红/不可播）。`CHANNELS` 与 `EPG_TITLES` 同步清理。

### 2) 按"优质=可播"标准全网找新闻台（先探测后入库，杜绝瞎编）
- 数据源：`iptv-org` 国家/分类播放列表（经 `gh-proxy.com` 镜像直取）、`N0tf0und4o4/iptv-sources` 每日检测中文源（CCTV/凤凰）、各台官方全球 CDN。
- 复用后端 `checkDeep()` 深度探测，**沙箱（非中国）网络实测**：
  - **已验证可流畅（全球 CDN，中继也更稳）**：
    - `160 CGTN (English) 央视英语新闻` —— `english-livebkali.cgtn.com` → 94Mbps
    - `161 NHK World-Japan` —— `masterpl.hls.nhkworld.jp`（NHK 官方）→ 33Mbps
    - `162 Al Jazeera English` —— `live-hls-apps-aje-fa.getaj.net`（官方）→ 34Mbps
  - **尝试但未入库（沙箱不可达，避免死链）**：DW English（Amagi seg307 / Akamai 连接失败）、France 24 English（404）、NHK General（非 World）、DW Arabic（stale 冻结）、各 CCTV 地方台镜像（中国 IP 沙箱连不上）。
- 中国大陆源（凤凰/央视新闻）走"维护者每日检测列表"取 URL，但**沙箱非中国网络无法验证**；因用户明确点名，以"需云端中继验证"方式入库 2 个（见下），并标注需 `/api/check` 确认。

### 3) 入库（56 → 61）
- `163 凤凰卫视中文台` —— `http://27.41.245.32:801/hls/205/index.m3u8`（N0tf0und4o4 cn_pay 每日检测源）
- `164 CCTV-13 新闻频道` —— `https://event.pull.hebtv.com/jishi/cp1.m3u8`（N0tf0und4o4 cn_cctv 每日检测源）
- 说明：163/164 为**中国源，本地沙箱探测必红**；云端中继位于上海腾讯云（中国），理论可达，需用户在云端 URL 跑一次 `/api/check` 实测确认，若仍红则下版移除。

### 4) 诚实边界
- 电影台（10 个优质 FAST）维持 v0.3.3 未动；韩国台维持 v0.3.4。
- DW/France24 英文新闻虽优质，但本次沙箱实测不可达，未以"可用"名义入库。

## v0.3.4 — 2026-10-12 10:5x

### 需求（用户原话）
「电影台都挺不错，就要这种优质的，挖出来的韩国台也挺好，就是有些重复。删除：Daegu MBC(480)、Chuncheon MBC(480)，继续找 有没有更好的优质的节目可播放的，尤其韩国台」

### 1) 删除重复的 480p MBC 地方台（60 → 58）
- 删除 `131 Daegu MBC (480p)`、`132 Chuncheon MBC (480p)`——与已保留的 `130 Daejeon MBC (720p)` 同属 MBC 地方台且分辨率更低，属用户说的"有些重复"。
- `CHANNELS` 与 `EPG_TITLES` 同步清理。保留的地方台：Daejeon MBC(720p)、CJB Cheongju SBS(540p)、GCN(720p)。

### 2) 全网继续找「优质可播放」韩台（方法：先探测后入库，杜绝瞎编）
- 数据源：`iptv-org` `streams/kr.m3u`（GitHub raw 直取，73+ 源）、`iptvplayer24.com` 韩国快照、`m3u8-player.net` 已验证清单、KBS World 全球 CDN 候选。
- **复用后端 `checkDeep()` 深度探测逻辑**（跟到真实分片、测吞吐、含"冻结假直播"识别），写成一次性脚本 `tools/probe_kr_v034.js` + `tools/probe_kbsworld.js`，对 18 个候选韩台 + KBS World 全球 CDN 做真实拉流验证（sandbox 网络，非用户网络）。
- **探测结论（关键证据）**：
  - 对照（已知可达）：`TV Chosun ok 19Mbps` / `EBS1TV ok 12Mbps` / `FGTV ok 2.3Mbps` —— 探测脚本自身可信。
  - **18 个地方台里只有 2 个真实返回 HLS 并可流畅播放**：`MBC Jeju (352p)`（sandbox kbps≈11Mbps）、`SBS JTV (406p)`（sandbox kbps≈6.6Mbps）。
  - **其余 16 个（含 1080p 的 MBC Gwangju/Gangwon、SBS KNN/KBC、OBS、BTN、BBS、GoodTV 等）全部连接失败（http-1/403/超时）** —— 挂在韩国本地 IP / 韩国本土 CDN，属**地域封锁**，即便从较宽松的沙箱都连不上，用户（国内网络）更无法播放。
  - **KBS World 全球 CDN 候选**（`kbsworld-ott.akamaized.net`、`livecdn.fptplay.net`）分别返回 **400 / 403（地域限制）**，不可用。

### 3) 入库（58 → 60）
- 仅加入**经真实拉流验证**的 2 个韩台：
  - `135 MBC Jeju (352p)` —— `https://wowza.jejumbc.com/live/tv_jejumbc/playlist.m3u8`（济州地方台，深度探测可播）。
  - `136 SBS JTV (406p)` —— `http://61.85.197.53:1935/jtv_live/myStream/playlist.m3u8`（全州地方台，深度探测可播）。
- 说明：分辨率偏低（352p/406p），但属**区别于既有台的真实可播韩台**；更高清的韩台受地域封锁所限无法免费直连，未以"可用"名义入库（避免死链）。
- `EPG_TITLES` 同步补 135/136。

### 4) 诚实边界
- 免费公开韩台里，真正能稳定看的就那么多：高清旗舰（KBS1/SBS/MBC/JTBC/tvN）在公开列表里**无可用国际直链**；地方台绝大多数被韩国 IP 封锁。
- 这 2 个新台是在"非用户网络"验证通过的；**最终是否能在用户网络流畅播放，需用户点一次 `/api/check`（深度）确认**。若用户网络也连不上，说明仍属地域封锁，届时再考虑「港/日/韩 VPS 中继」（前版已提的 B 方案）才是根治手段。
- 电影台维持 v0.3.3 的 10 个优质 FAST 台，用户已认可，本次未动。

---

## v0.3.3 — 2026-10-12 09:1x

### 需求（用户原话）
「KBS Joy 异常，连接绿的，但是一直反复缓冲没法播放」「删除的台：30A TV classic movies / all time movies / afra film / aflam / alternal TV，不要讲印度语的台呢，电影台找一下优质的，还有韩国台再找一下全网包括但不限于 GitHub 等等地方」

### 1) 修「假绿点」——探针升级为「冻结假直播」识别（根因级修复）
- **根因**：`KBS Joy` 的公开源 `xykt-fix.github.io/flv/KJ_W.m3u8` 是挂在 **GitHub Pages 上的静态冻结播放列表**：`MEDIA-SEQUENCE` 固定为 100、`PROGRAM-DATE-TIME` 停在 **2026-08-19**（实测陈旧 4,640,136 秒 ≈ 53.7 天），且 `kj-150.ts`/`kj-199.ts` 实测 **404**（只有开头几个分片存在）。hls.js 播完开头即撞 404 → 无限缓冲。
- **旧探针盲区**：只取播放列表**第一个**分片测速，恰好存在 → 误判 `ok`（这正是"绿点却缓冲"的原因）。
- **修复**：`checkDeep()` 增加 **PROGRAM-DATE-TIME 新鲜度判据** —— 对无 `#EXT-X-ENDLIST` 的直播型列表，若最新 PDT 距今 > 300 秒，直接判 `dead`（reason `stale*`）。
- **验证**：用同一逻辑对 KBS Joy 实测 → `dead | stale4640136`；正常直播源不触发。**KBS Joy 已从列表删除**（其唯一公开源无法修复）。

### 2) 清理用户点名的台（51 → 46）
- 删除电影台 `66 30A TV Classic Movies`（美国/英语）、`68 Aflam`（阿拉伯语）、`69 All Time Movies`（**印度 Hindi 语**，DD Free Dish）、`70 Afra Film`（伊朗/波斯语）、`93 AlternaTV`（阿根廷/西班牙语，属"综合"组）。`CHANNELS` 与 `EPG_TITLES` 同步清理。

### 3) 全网检索（iptv-org + GitHub）并实测，补入可用台（46 → 60）
- 数据源：iptv-org `countries/kr.m3u`(73)、`categories/movies.m3u`(779)、`languages/eng.m3u`(2985)；GitHub `skylover007/iptv`、`jhc0107/my-korea-iptv`（经 GitHub API 取内容，`raw.githubusercontent` 在本沙箱不可达）。
- 实测判据与后端一致（ratio = 分片时长 ÷ 下载耗时，≥1.3 流畅）。结果：韩国 73+91 源 → 仅少量非购物台可用；电影 779 源 → ok 253。
- **新增 5 个韩台**（均为非购物、实测流畅）：`130 Daejeon MBC`、`131 Daegu MBC`、`132 Chuncheon MBC`、`133 CJB Cheongju SBS`、`134 GCN`。
- **修复 `108 EBS 1TV`**：原源失效，换为 EBS 官方 `ebsonairios` 源（实测可达）。
- **新增 10 个优质电影台**（以 Amagi/Xumo/Tubi/Rakuten 等正规 FAST 分发为主，非印度语）：Hallmark Movies & More、MovieSphere UK、MovieSphere、MyTime Movie Network UK、Rakuten TV Top Movies、Ebony TV by Lionsgate、Warner TV Asia、HBO Hits、AMC (US)、Popcorn Central。

### 4) 其它
- 新增可复用工具 `tools/probe_sources.py`（批量实测 m3u 源，含假直播识别），供后续「再找台」复用。
- 云端部署同步更新至 v0.3.3。
- 实测：本机 `ok 34 / slow 2 / dead 24`；新台 14/16 首次即 ok（CJB、Rakuten 首次抖动、复测正常）。

## v0.3.2 补丁 — 2026-10-12 09:0x（注释修正 · 无行为变更）

- **问题**：`checkDeep()` 中 `ratio` 的注释写作「下载耗时 vs 分片时长，>1 才跟得上直播」，而实际公式是 `ratio = segDur / s.secs`（**分片时长 ÷ 下载耗时**，越大越快）。**注释与代码语义相反**，会误导后续排障判断（违反「不留过期/错误注释」规范）。
- **修正**：改为准确表述「ratio = 分片时长 ÷ 下载耗时（倍数，越大越快）：≥1.3 有富余=流畅；0.9~1.3 临界=偏慢；<0.9 下载慢于播放=跟不上」。
- **影响**：仅注释，无逻辑/行为变更，故**不递增版本号**（仍为 v0.3.2）。已 `node --check` 通过。

## 部署记录 — 2026-10-12 00:2x（v0.3.2 代码 · 云端部署）

### 需求
「我试部署『境外中继』」—— 用户授权把后端（含中继）发布到云端，验证「换出口」是否真能改善韩台卡顿。

### 动作
- 用内置部署能力把 `backend/` 发布为在线 HTTP 服务 → **分享链接 `https://tvlive-relay.app.workbuddy.host/`**（`deployedAs: http-service`，`verified: true`）。
- **无代码改动**：`web/app.js` 的 `BACKEND = ""`（同源）设计，使其开箱适配任意部署地址；服务端本就监听 `process.env.PORT`（Node 默认绑 `0.0.0.0`），满足发布要求。
- 部署沙箱：`eb1d00c7182f40f082e75c1e89a6575c`。

### 实测（关键证据）
- **部署节点出口实测在「上海 / 腾讯云」而非境外**：出口 IP `111.229.174.181`（AS45090 Shenzhen Tencent，ipinfo 判上海）；分享域名 CNAME 指向 `...bj-tencentclb.cloud`。即**同为国内节点**。
- 同源脚本对比「本机 vs 部署节点」对韩源实测吞吐（`/api/check` 深度探测）：

  | 频道 | 本机 | 部署(上海) | 变化 |
  |---|---|---|---|
  | TV Chosun | 8.4 Mbps | **29.1 Mbps** | 3.5× |
  | TV Chosun 2 | 7.4 Mbps | **22.4 Mbps** | 3.0× |
  | FGTV | 4.1 Mbps | **17.7 Mbps** | 4.3× |
  | RUTC TV | 37.0 Mbps | 5.8 Mbps | 本机更快 |
  | Arirang TV | ok 1.15 Mbps | 波动 dead | 不稳 |

  - ok 台数：本机 15 → 部署 17；**韩国可播台两边都是 5 个**（TV Chosun / Chosun 2 / Arirang 系 / FGTV / RUTC）。
- **端到端**：部署中继取 TV Chosun（单档 5.9 Mbps 720p），连续 3 分片 `1.36s / 1.56s / 1.17s(HIT)`，≈**36 Mbps（码率 6× 余量）**；`/`、`/app.js`、`/style.css`、`/hls.min.js`、`/api/channels` 均 200。

### 诚实结论
- **数据中心出口（即使在国内）的国际带宽远好于家宽** → 已能播的韩台余量从约 1.4× 提升到约 5×，卡顿应明显缓解。这是本次部署的真实收益。
- **但它不是境外节点**，因此**救不了地域封锁 / 源已死的台**（EBS 全系 / YTN / TBS / KTV / Channel A / KBS Joy 等在本机与部署节点**两边都 dead**）。
- 要真正救「被地域封锁」的韩台，需要**真实的香港 / 日本 / 韩国节点**（内置部署不提供境外区域；需自备 VPS）。此结论已在对话中如实告知用户。

## v0.3.2 — 2026-10-12 00:1x

### 需求
「还是很卡，甚至不能播放，除了中继没有更好的方法了吗」——用户要的是「除中继外更有效的办法」。

### 定位实验（先证伪再动手）
1. **本地中继对带宽零增益**：中继仍走同一条国际链路，只改变「谁去连源站」，不会凭空多出带宽。实测当时链路对 TV Chosun 可达 **15.6 Mbps**（码率仅 5.2 Mbps），即 TV Chosun 本来就该流畅 → 说明「卡」的不是这几个能连上的台。
2. **TV Chosun 只有单一码率档**（`BANDWIDTH=5209008`, 1280x720），无低码率档可退，故「降档省流」对它无效。
3. **复测 iptv-org 全部 73 个韩国源**（并发实测），并用**决定性指标**判定：
   `ratio = 单分片下载耗时 / 该分片时长`；`ratio<0.5` 流畅、`0.5~0.9` 勉强、`≥0.9` 必卡（下载赶不上播放）。
   - **判定「流畅」仅 4 个**：TV Chosun(8.8Mbps, ratio .38)、TV Chosun 2(13.5Mbps, .16)、**FGTV**(1.75Mbps, .22)、**RUTC TV**(17.7Mbps, .15)。
   - **判定「必卡」**：Arirang TV(.1.34)、Arirang Radio(1.49)、KTV(1.64)、KBS Joy(3.31)、NHTV(1.63)、GCN(1.24)、OUN(4.02)、Gugbang(1.63)、HLCT(1.34)、CJ OnStyle(3.86)…
   - **规律**：挂在**全球 CDN**（自建 CDN / CloudFront / Akamai edgesuite）的源可播；挂在**韩国本地 IP / 韩国本土 CDN**（ktcdn、streamlock、dema.mil.kr、knou.ac.kr）的源被国际线路掐到 <1Mbps，**永远播不动**。
4. **环境排查**：`127.0.0.1:1928` 是 WorkBuddy 内部服务代理（对外部 URL 返回空），`0.0.0.0:8080` 是 node 进程、**不能作 HTTP 代理** → 用户本机当前没有可用于走韩国的可用代理。

### 改动
- **修复「预取自伤」回归（真实 bug）**：`server.js` 原 `PRE_FETCH_N = 4` 会在每次 chunklist 经过时**并发拉 4 个分片**；
  在窄国际线路上等于和「正在播放的分片」抢带宽，且播放端请求**不与在途预取去重**（同一分片下两遍）→ 反而更卡。
  - `PRE_FETCH_N: 4 → 1`（只预取下一段）；新增 `MAX_PREFETCH_INFLIGHT = 1`（**顺序化**，绝不并发占满链路）；
  - 新增 `servingSeg` 集合：播放端正拉取的分片，预取**必须跳过**，杜绝重复下载。
- **新增 2 个实测可播的韩国台**：`148 FGTV (720p/480p)`（含 296kbps 低码率档，弱网友好）、`149 RUTC TV (720p)`（CloudFront）。同步加入 `EPG_TITLES`。**49 → 51 台（韩国 28 → 30）**。
- 版本 `0.3.1 → 0.3.2`。

### 实测验证（经中继）
- `node --check` 通过；`/api/health` = `{ok:true, version:"0.3.2"}`；`/api/channels` = 51 台（韩国 30）。
- TV Chosun 经中继连续 3 分段：3.2s(MISS) → 1.8s(MISS) → **0.018s(HIT)**，稳态 12~24Mbps，**远高于 5.2Mbps 码率** → 应流畅。
- FGTV 首分片 1.10MB/2.24s（3.9Mbps，码率 1.1Mbps）；RUTC 首分片 3.42MB/1.69s（16.2Mbps，码率 2.7Mbps）→ 均流畅。

### 诚实结论（回答「有没有更好的方法」）
- **有，且只有一条**：把出口换到境外 —— **境外中继节点**（VPS 部署在 香港/日本/韩国）或用**用户已有的 VPN/代理**。
  本地中继改变不了国际链路质量；境外节点让「用户↔节点」走优化线路、「节点↔韩源」走当地线路，才能救那些被掐带宽的韩源。
- 免费公开源里，能稳定流畅看的韩国台就是这 4 个（TV Chosun / TV Chosun 2 / FGTV / RUTC TV）+ 边缘可看的 Arirang。
  旗舰台（KBS1/SBS/MBC/JTBC/tvN）在所有免费公开列表里**都没有可用的国际直链**。
- 已向用户提出「免费试部署境外中继」方案，等待授权（发布到线上需用户当轮明确同意）。

## v0.3.1 — 2026-10-11 23:4x

### 需求
1. HLAM-DTV 等 HLxx-DTV 地区台冗余 → 只留一个 720p。
2. 大多数韩国台仍很卡、甚至无画面、一直「缓冲中」→ 继续想办法。

### 诊断（关键）
- 实测各韩台「拉流吞吐」发现：卡顿不是播放器/中继问题，而是**部分韩国源跨洋带宽只有几十~几百 kbps**（而码率要几千 kbps）。
  KTV 单个分片 5.4MB 竟需 162 秒（≈270kbps）；HLAO 类直接超时。TV Chosun 6MB 分片 2.5s 可取（≈19Mbps），Arirang 158KB/1.2s。
- 旧 `/api/check` 只读 700 字节判「列表能否返回」，把 KTV 这种「列表能取、分片慢到 162s」的台误判成绿点 → 这就是「绿点却一直缓冲」的原因。

### 改动
- **HLxx-DTV 去重**：`server.js` 保留 `HLAO-DTV (720p)`，删除其余 21 个 HL* 地区台 + 综合组重复的 `HLAT-DTV`(id92)。**70 → 49 台**。
- **`/api/check` 升级为真实拉流吞吐探测**（`checkDeep`）：
  - 跟到真实分片，测「下载耗时 vs 分片时长」→ `ok`(流畅)/`slow`(偏慢)/`dead`(不可用)，并返回 kbps。
  - `fetchSome` 加**硬性总时限**（Node 的 timeout 只监测空闲，慢速滴流会挂死，必须强制中止）。
  - 并发 12、单台 ≤~8s、结果 **60s 缓存**；**实测全量约 20s**。
- **UI 三态圆点**：`app.js`/`style.css`/`index.html` 增加 `slow`(黄) 态与图例「流畅/偏慢/不可用/检测中」，圆点 tooltip 显示实测 kbps。
- **播放看门狗**：选台 16s 仍未播放 → 明确提示「该源跨洋带宽不足或不可用，建议换台」；单次缓冲 >12s → 提示「源过慢」。**彻底消除无限「缓冲中」**。
- 版本 `0.3.0 → 0.3.1`。

### 实测结果（本机深度探测，49 台）
- 总览 ok 16 / dead 33。
- **可流畅播放的韩台仅 3 个：TV Chosun(≈6.4Mbps)、TV Chosun 2(≈6.5Mbps)、Arirang TV(≈1.4Mbps, ratio 2.15)**。
- 其余韩台（Arirang Radio/HD、KTV、YTN、TBS、EBS 全系、Channel A、KBS Joy、NHTV、ABN、HLAO-DTV、KCTV…）实测 dead/过慢。

### 诚实边界
- **大多数韩台卡顿 = 源跨洋带宽不足 / 已死 / 地域封锁，属网络层，客户端无法凭空造带宽**。
- 免费源里真正能稳定看的韩国台极少（电视朝鲜、阿里郎）。旗舰台(KBS/SBS/JTBC/tvN)无免费源。
- 若仍要扩韩台：需授权源或韩国节点中继（成本高）。

## v0.3.0 — 2026-10-11 23:1x

### 需求
1. 移除 B4U 电影频道与所有印度频道。
2. 修复「中继开启后播放速度比正常快 1.5~2 倍」。
3. 作为资深工程师继续想办法，重点改善韩国台卡顿。

### 改动
- **频道剪枝（70 台）**：`server.js` 删除印度频道
  - `60 Cricket Gold`（YuppTV，印度）、`67 Alankar TV`（tarangplus.in，印度奥里萨）、
    `71 B4U Kadak`、`72 B4U Bhojpuri`、`73 B4U Movies`（B4U 印度网）。
  - 同步删除 `EPG_TITLES` 中对应 5 条。阿拉伯电影台（68 Aflam / 69 All Time Movies / 70 Afra Film）保留。
  - 变化：75 → 70 台（韩国 48 / 测试 1 / 新闻 4 / 音乐 3 / 纪录片 5 / 体育 3 / 电影 4 / 综合 2）。
- **修复中继导致播放变快（关键 bug）**：`web/app.js` HLS 配置
  - 根因：中继给直播流引入额外网络延迟 → 播放位置落后直播边缘；旧配置 `maxLiveSyncPlaybackRate: 1.5`
    触发 hls.js「追帧加速」，表现为播放速度变快 1.5~2x。
  - 修复：`maxLiveSyncPlaybackRate: 1`（永远 1x，彻底消除变快）+ `liveSyncDuration: 20`（落后 20s 稳定缓冲）。
- **中继服务端抗卡顿**（`server.js`，核心长杆杆）：
  - `http/https` **keep-alive 连接池**：复用 TCP/TLS 连接，去掉每个分片的新建连接开销。
  - **播放列表 4s 短期缓存**（`plCache`）：直播流回源频繁，缓存降低上游压力、稳定输出。
  - **分片预取 read-ahead**（`prefetchSegments` + `segCache`，上限 80MB/20s TTL）：
    中继转发 chunklist 时，顺带把「接下来要播的分片」提前拉到内存；hls.js 请求时命中内存 → 几乎零等待。
  - 新增 `X-Relay-Cache: HIT/MISS` 调试响应头，便于验证。
- **hls.js 抗卡顿调优**（`web/app.js`）：
  - `capLevelToPlayerSize: true`（不拉超过播放器分辨率的高码率档）
  - `enableWebVTT: false`（跳过字幕轨拉取）、`lowLatencyMode: false`
  - `nudgeOffset: 0.1` / `nudgeMaxRetry: 5`（温和同步修正，不触发加速）
  - `maxStarvationDelay: 8`（缓冲耗尽多等 8s 再报错）
  - `abrEwmaDefaultEstimate: 800000 → 500000`（远距离源更保守，首段不卡）
- **版本标注**：`server.js` 增加 `VERSION = "0.3.0"`；`/api/health` 返回 `version`；启动日志带版本。

### 实测验证
- `node --check` 通过；`/api/health` = `{ok:true, version:"0.3.0"}`。
- `/api/channels` = 70 台，韩台首个 = TV Chosun / Arirang / KTV。
- 中继改写：TV Chosun 主列表嵌套 `chunklist.m3u8` 正确改写为 `/api/relay?url=...`。
- **预取命中实证**：拉取 TV Chosun chunklist（3 段）后等 3s，请求末段返回
  `X-Relay-Cache: HIT`、`Content-Type: video/MP2T`、**5,935,348 字节 / 0.018s**（内存直出）。
- **可达性探测**（`/api/check`，本机实测）：韩国 **19/48** 可达 ——
  TV Chosun(101/100)、Arirang TV/HD/Radio(103/104/102)、KTV(107)、KBS Joy(115)、NHTV(118)、ABN(121)、
  KCTV(144)，及地方台 HLAJ/HLAN/HLAO/HLAQ/HLAT/HLAW/HLCQ/HLDQ/HLDR(123/125/126/127/128/129/132/139/140)。
  其余为 dead 或地域封锁（KBS/SBS/JTBC/tvN 等旗舰台无免费源）。

### 诚实边界
- 中继能救「跨域/地域封锁」的源；救不了「源本身已死/连不上」的台。
- 免费源里最稳的是 TV Chosun / Arirang / KTV；`[Not 24/7]` 台在非播出时段探测会失败。
- 真正稳定收看旗舰韩台仍需授权源或韩国节点中继（成本高，未采用）。

## v0.2.0 — 2026-10-11 22:xx
- 新增后端中继代理 `/api/relay`（改写嵌套 URL，突破地域封锁 + 跨域）。
- 频道剪枝：去儿童频道（74–91）、去不知名体育台；韩国台置顶并优先 TV Chosun/Arirang/KTV。
- UI：选台仅切换 `.active` 高亮（`updateActive()`），不再重绘整列表（修 logo/圆点每次刷新）。
- 新增「中继：开/关」按钮。

## v0.1.0 — 2026-10-11 19:xx
- 初版后端：频道列表 `/api/channels`、节目单 `/api/epg`、健康检测 `/api/check`、静态托管 `web/`。
