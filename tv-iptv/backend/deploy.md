# TvLive 后端自建部署指南（不依赖任何托管平台）

> 目标：后端跑在你自己有完全控制权的机器上。部署、升级、回滚全部一条命令，
> 不再受托管平台网关加码、空闲休眠、链接失效等影响——平台的规则再也管不到你。

## 0. 为什么值得自建

后端是**零依赖 Node 单文件**（纯标准库，无 node_modules、无数据库），
这是它最大的优点：任何一台 64 位 Linux 机器都能跑。

回看 `../HISTORY.md`，近期事故几乎全是托管平台引起的，而非代码 bug：

| 事故 | 根源 |
|---|---|
| v0.3.28 网站/App 全打不开 | 平台网关加 sharecode 校验 |
| v1.4.4 回放页偶发「工作空间已停止」 | 平台空闲休眠 |
| 2026-11 旧电视回放 403「链接不完整」 | 网关校验 + 老设备 WebView 丢 cookie |
| 每次上线都要回到特定环境 | 服务只能在那个平台重发布 |

自建后，这四类问题一次性消失。

## 1. 准备一台机器

| 选项 | 建议 | 说明 |
|---|---|---|
| **境外 VPS（推荐）** | 香港/日本，1核1G 起步 | 后端只做转发+内存缓存，占用极小；离韩国近对韩源反而更快（现在的上海中继是绕路）。无需备案 |
| **家里旧电脑/NAS** | 能装 Docker 即可 | 电视同一局域网内直连，零延迟零流量；外网访问见 §5 |

装 Docker（以 Debian/Ubuntu 为例）：

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. 部署（一条命令）

```bash
git clone https://github.com/choileo333/livetv.git
cd livetv/tv-iptv/backend
docker compose up -d --build
```

自检（逐级验证服务/频道/回放链路/中继，全绿即可用）：

```bash
./healthcheck.sh http://127.0.0.1:8899
```

## 3. App 指向新后端（无需重装）

手机和电视都一样：App 顶栏「**后端**」→ 填入 `http://<你的机器IP>:8899` → 「保存并重载」。

- 状态行显示「共 N 台（来源：后端）」即为连通（自建后 N 应与 `/api/channels` 一致）。
- 电视与后端在同一局域网时，直接填内网 IP（如 `http://192.168.1.10:8899`），最快最稳。
- App 已放开明文 HTTP（`usesCleartextTraffic`），无需域名和证书即可用；
  要 HTTPS 的话，最省事是加一个 Caddy 反代（自动证书），`reverse_proxy 127.0.0.1:8899` 两行配置。

## 4. 升级 / 回滚

```bash
# 升级
cd livetv && git pull
cd tv-iptv/backend && docker compose up -d --build

# 回滚到任一历史版本
git log --oneline            # 找到旧版本 commit 号
git checkout <commit号>
cd tv-iptv/backend && docker compose up -d --build
```

数据都在后端内存里（缓存/token），重启自动重建，无需备份。

## 5. 家里设备外网访问（可选）

在家部署但出门也想用手机看时，二选一：

- **Tailscale（最简单）**：后端机器和手机各装一个，登录同一账号，
  App 里填 `http://100.x.x.x:8899`（Tailscale 分配的 IP）即可，全程加密免配置。
- **frp 内网穿透**：需要一台有公网 IP 的机器做中转，配置略多，延迟取决于中转机。

## 6. 与 workbuddy 旧链接并存

旧链接 `https://tvlive-relay.app.workbuddy.host`（若还活着）可以继续当**备胎**：
平时用自建地址，自建机器挂了就在 App「后端设置」里临时切回旧地址。两套互不影响。

## 7. 安全须知（重要，公网部署前必读）

`/api/relay` 当前对任意 URL 开放、无鉴权（详见本次 review 结论），公网部署等于开放代理：

1. **VPS 上**：建议防火墙只放行自己的 IP（`ufw allow from <你的IP> to any port 8899`），
   或至少改掉默认端口；
2. **家里部署**：只要路由器不做端口映射，外网本来就连不进来，风险天然可控（推荐）；
3. 自建环境没有平台网关，`sharecode` 参数不再起任何作用（保留无害）；
4. 另请自行确认内容源的播放授权边界（同 README 的边界声明）。
