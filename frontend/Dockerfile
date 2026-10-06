# syntax=docker/dockerfile:1
# 本地开发、CI 构建、容器部署走同一条流水线：
# 先跑检修人员台账初始化与幂等/对账校验，校验不过直接构建失败，再做类型检查与前端构建。
FROM node:20-alpine AS build
WORKDIR /srv/web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node scripts/init-data.mjs --verify \
  && npm run typecheck \
  && npm run build

FROM nginx:1.27-alpine AS deploy
COPY --from=build /srv/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
