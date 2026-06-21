FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/patch-midscene-sleep.mjs scripts/patch-midscene-extractor.mjs ./scripts/
RUN npm ci

COPY tsconfig.json playwright.config.ts ./
COPY src ./src
COPY e2e ./e2e
COPY scenarios ./scenarios
COPY scripts ./scripts
COPY web ./web
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY tests ./tests
COPY vitest.config.ts ./

RUN chmod +x /app/docker/entrypoint.sh \
  && npm --prefix web ci --include=dev \
  && npm run typecheck \
  && npm --prefix web run build

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV UI_PORT=3840

EXPOSE 3840

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["npm", "run", "ui:start"]
