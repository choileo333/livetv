# TvLive — 你自己的 Android TV 直播 App（原创脚手架）

> 本项目是**完全原创**的 Android TV 直播播放器脚手架，灵感来自对 `SUN1246-1.apk`（com.lemo.fairy）的逆向分析，
> 但**所有代码均为自有实现，不引用、不依赖任何第三方受保护 SDK（如 ForceTV）、不复制其 license / 加密 / 授权逻辑**。
>
> 它复刻的是「能力」（直播播放、频道列表、数字键盘切台、EPG、收藏、开机自启、本地控制、加密存储），
> 而不是「别人的壳与锁」。

## 技术栈（全部开源、可商用）
| 能力 | 选用 | 说明 |
|---|---|---|
| 视频播放 | **Media3 / ExoPlayer** (Apache-2.0) | 支持 HLS / RTSP / RTMP |
| 本地存储 | **腾讯 MMKV** (BSD) | 自行管理密钥，加密存储 |
| 频道/EPG 后端 | **Node 零依赖 http** | 你自己的服务，见 `backend/` |
| UI | **RecyclerView + PlayerView** | 电视端方向键导航 |
| 语言 | **Kotlin** | — |

## 已实现的功能（对应原 App 的「能力」）
1. **直播/点播播放** — `player/VideoPlayer.kt`，按协议自动选择 HLS/RTSP/RTMP 源。
2. **频道列表（自有后端）** — `data/ChannelRepository.kt` 先拉 `backend /api/channels`，失败回退本地列表。
3. **遥控器数字键盘切台** — `ui/NumberBoardDialog.kt` + `MainActivity.onKeyDown`。
4. **节目单 EPG** — `data/EpgRepository.kt` 拉 `backend /api/epg`，主界面右侧显示「正在播出 / 接下来」。
5. **收藏** — `storage/ConfigStore` 用 MMKV 字符串集合存收藏频道；列表星标 + F 键切换；「仅看收藏」筛选（P 键）。
6. **设备激活 / 账号** — `auth/AuthManager.kt`，用 Android ID 做自有设备标识，可接你自己的后端。
7. **本地 HTTP 控制服务** — `net/ControlServer.kt`，**端口 9910（自有，避开原 App 的 9906）**。
8. **开机自启** — `receiver/BootReceiver.kt`，由 `ConfigStore.isAutoBoot()` 偏好控制。
9. **加密存储** — `storage/ConfigStore.kt`（MMKV）。

## 目录结构
```
tv-iptv/
├── build.gradle                      # 依赖：ExoPlayer + MMKV（无第三方 license SDK）
├── settings.gradle
├── gradle.properties
├── backend/                          # 你自己的频道/EPG 后端（Node 零依赖）
│   ├── server.js                     # GET /api/channels、/api/epg、静态托管 web/
│   ├── package.json
│   ├── README.md
│   └── web/                          # 浏览器演示页（复用同一后端，看得见流程）
│       ├── index.html
│       ├── style.css
│       └── app.js
└── src/main/
    ├── AndroidManifest.xml
    ├── java/com/yourapp/tvlive/
    │   ├── TvLiveApp.kt
    │   ├── model/Channel.kt          # 频道模型
    │   ├── model/EpgProgram.kt       # EPG 单条模型
    │   ├── data/ChannelRepository.kt # 频道源（后端优先 + 本地回退）
    │   ├── data/EpgRepository.kt     # EPG 源
    │   ├── player/VideoPlayer.kt     # ExoPlayer 封装
    │   ├── auth/AuthManager.kt       # 自有激活/账号
    │   ├── storage/ConfigStore.kt    # MMKV（含收藏、后端地址）
    │   ├── util/DeviceUtil.kt
    │   ├── net/ControlServer.kt      # 本地控制服务(9910)
    │   ├── receiver/BootReceiver.kt
    │   └── ui/                       # MainActivity / ChannelAdapter / NumberBoardDialog
    └── res/                          # 布局、字符串、图标、主题
```

## 快速验证（无需 Android SDK）
沙箱无模拟器，但后端 + Web 演示可立即运行验证「频道→播放→切台→EPG→收藏」完整链路：

```bash
cd tv-iptv/backend
node server.js                       # 默认 http://localhost:8899
# 浏览器打开 http://localhost:8899/ 即可看到演示页
# 接口自测：
#   curl http://localhost:8899/api/channels
#   curl "http://localhost:8899/api/epg?channelId=1"
```
Web 演示用 hls.js 播放 HLS 测试流；RTSP/RTMP 源浏览器无法播放，仅 App 端支持（已在页面给出提示）。

## 如何构建 / 运行 Android App
需要 **Android SDK（API 34）+ Gradle**。本沙箱未安装 Android 构建工具，故 Android 代码为「结构正确、可编译」级别，未做真机/模拟器编译验证（已做：R 引用解析检查、零受保护依赖检查）。

1. 安装 Android Studio 或命令行 SDK（compileSdk 34）。
2. 把 `com.yourapp.tvlive` 改成你自己的包名（build.gradle + AndroidManifest）。
3. 在 `ConfigStore.getBackendUrl()` 填入你后端地址（TV 盒子上用局域网/公网 IP）。
4. 在 `backend/server.js` 的 `CHANNELS` 填入**你有权播放**的频道地址。
5. 构建：`gradle assembleDebug`，安装到电视/盒子。

## 边界声明（重要）
- 本项目**不破解、不绕过**任何第三方软件的加密、授权或 license 机制。
- 频道源、账号后端、控制协议均为**你自己的**，与原 App 的受保护服务无关联。
- 如用于生产，请确保所有内容源具备合法授权。

## 后续可扩展
- 接自有登录/会员体系（扩展 `AuthManager`）。
- 用 `ControlServer` 实现远程遥控（HTTP/WebSocket 指令）。
- 多源切换、时移回看、EPG 持久化缓存。
