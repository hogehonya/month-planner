FROM node:24-alpine
ARG APP_REVISION=unknown
ENV APP_REVISION=$APP_REVISION
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY --chown=node:node public ./public
COPY --chown=node:node netlify ./netlify
COPY --chown=node:node local-runtime ./local-runtime
COPY --chown=node:node netlify.toml ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "local-runtime/healthcheck.mjs"]
CMD ["node", "local-runtime/server.mjs"]
