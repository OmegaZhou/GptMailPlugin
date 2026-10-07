FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN mkdir /app/state && chown node:node /app/state
USER node
ENV MAIL_BIND_HOST=0.0.0.0 PORT=3000 MAIL_SERVER_CONFIG=/run/config/config.json MAIL_STATE_DIR=/app/state
EXPOSE 3000
CMD ["node", "dist/server.cjs"]
