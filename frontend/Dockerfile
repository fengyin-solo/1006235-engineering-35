# 构建、上线、部署同一条流水线：类型检查 → 迁移链路自检 → 生产构建 → 静态托管。
FROM node:20-bookworm-slim AS build
WORKDIR /srv/web

# 先拷依赖清单，按 lockfile 固化安装。
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# 迁移链路自检不过，构建直接失败：本地与部署环境同一套初始化口径。
RUN npm run build

FROM nginx:1.27-alpine AS serve
COPY --from=build /srv/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
