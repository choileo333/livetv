# TvLive 后端自建部署镜像（零依赖 Node 单文件，无 node_modules）
# 构建+运行：docker compose up -d --build（推荐，见 docker-compose.yml）
# 或裸 Docker：docker build -t tvlive-backend . && docker run -d -p 8899:8899 --restart unless-stopped tvlive-backend
FROM node:20-alpine

WORKDIR /app
COPY server.js package.json ./
COPY web ./web

ENV PORT=8899
EXPOSE 8899

# 自建环境没有平台网关，/api/health 无需 sharecode 即可访问
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "server.js"]
