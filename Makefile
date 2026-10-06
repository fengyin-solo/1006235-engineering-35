.PHONY: install frontend verify build image up down

install:
	cd frontend && npm ci

frontend:
	cd frontend && npm run dev

# 迁移链路自检：本地、CI、镜像构建都跑同一份。
verify:
	cd frontend && npm run verify

# 完整构建：类型检查 → 迁移自检 → 生产构建，任何一环失败即中止。
build:
	cd frontend && npm run build

# 部署镜像：容器内重跑同一条流水线，避免本地环境与部署环境口径漂移。
image:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down
