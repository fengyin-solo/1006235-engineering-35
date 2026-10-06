.PHONY: install frontend init verify smoke build up down

install:
	cd frontend && npm install

# 本地开发：先跑台账初始化，再起 dev server
frontend:
	cd frontend && npm run dev

# 只跑检修人员台账迁移初始化（生成 .init-snapshot/crew-ledger.json）
init:
	cd frontend && npm run init-data

# 初始化 + 幂等/对账校验
verify:
	cd frontend && npm run verify-data

# 浏览器数据层冒烟校验（首次播种、残档修复、反复初始化、双入口对账、动作联动）
smoke:
	cd frontend && npm run smoke

# 构建：初始化校验 → 冒烟校验 → 类型检查 → 产物构建，任何一步失败立即中断
build:
	cd frontend && npm run build

# 部署：与构建同一条流水线（Dockerfile 内先跑 init --verify 再构建 nginx 镜像）
up:
	docker compose up --build -d

down:
	docker compose down
