FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.3-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
