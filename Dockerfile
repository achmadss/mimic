# better-sqlite3 has no prebuilt binary for every platform (linux/arm64 included), so it may compile:
# the full image has python and a compiler, the runtime image does not need them
FROM node:22 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# tsx runs the TypeScript directly, so dev dependencies are runtime dependencies here
RUN npm ci

FROM node:22-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/main.ts"]
