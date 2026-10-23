# 嘎嘎香 H5 点单 · 微信云托管部署包
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
# 云托管默认把流量转发到容器的 8080 端口（服务设置中的「监听端口」）
ENV PORT=8080

# 先装依赖（利用镜像层缓存）
COPY package.json package-lock.json config.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 再拷贝应用代码（default-data 用于 CFS 挂载后的首启动数据播种）
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY data ./data
COPY default-data ./default-data

# 云托管会把监听端口通过 PORT 环境变量注入（默认 8080）
EXPOSE 8080
CMD ["node", "server.js"]
