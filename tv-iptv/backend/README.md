# TvLive 后端（你自己的频道/EPG 服务）

零依赖 Node 服务，向你自己的 App / Web 演示下发频道列表与节目单。

> 这是**你自己的**后端，不连接任何第三方受保护频道源（如原 App 的 ForceTV 授权后台）。
> 样例频道用的是**公开 HLS 测试流**，仅用于演示播放链路；生产环境请替换成你有权播放的源。

## 运行

```bash
cd tv-iptv/backend
node server.js            # 默认端口 8899，可用 PORT=9000 node server.js 改端口
```

> **自建部署（Docker 一条命令上线，不依赖任何托管平台）**：见 [deploy.md](deploy.md)；
> 部署后用 `./healthcheck.sh http://127.0.0.1:8899` 逐级自检。

## 接口

| 方法 | 路径 | 说明 | 返回 |
|---|---|---|---|
| GET | `/api/health` | 健康检查 | `{"ok":true,"ts":...}` |
| GET | `/api/channels` | 频道列表 | `[{id,name,url,logo,group,note}, ...]` |
| GET | `/api/epg?channelId=1` | 某频道节目单（按当前时间动态生成） | `{"channelId":1,"programs":[{title,start,end,desc}, ...]}` |

所有接口带 `Access-Control-Allow-Origin: *`，Web 演示可跨域拉取。

## 与 App 的对接

- `ChannelRepository.loadFromBackend("http://<你的服务器IP>:8899")` 拉取 `/api/channels`
- `EpgRepository.loadEpg("http://<IP>:8899", channelId)` 拉取 `/api/epg?channelId=`
- TV 盒子上把地址改成局域网/公网 IP 即可（见 `ConfigStore.getBackendUrl()`）。

## 换成你自己的内容

编辑 `server.js` 里的 `CHANNELS` 数组与 `EPG_TITLES` 即可；或把数据存储迁到数据库 / 配置文件。
