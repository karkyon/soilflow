# Cloud Run 用（12 環境・インフラ設計書）。リポジトリのルートで：docker build -f apps/api/Dockerfile -t soilflow-api .
FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @soilflow/pdf build && pnpm --filter api build 
ENV NODE_ENV=production PORT=8080 ADAPTERS=real \
    PDF_FONT_REGULAR=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc PDF_FONT_BOLD=/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc
WORKDIR /app/apps/api
USER node
CMD ["node", "dist/src/main.js"]
