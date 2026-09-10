FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund --no-audit

COPY . .
RUN npm run build

RUN npm install -g @openai/codex@latest

CMD ["bash", "-lc", "E2E_CHECK=1 node --import tsx --test tests/e2e/e2e-codex.test.ts"]
