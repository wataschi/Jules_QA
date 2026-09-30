FROM mcr.microsoft.com/playwright:v1.61.0-noble

WORKDIR /app

# Реєстр тест-кейсів працює на вбудованому node:sqlite, тому потрібен Node 22+.
# Перевіряємо на етапі збірки, щоб не отримати незрозумілу помилку в рантаймі.
RUN node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Потрібен Node 22+ (node:sqlite), а в образі ' + process.versions.node + '. Візьміть новіший тег playwright або власний образ на node:24.'); process.exit(1); } console.log('Node ' + process.versions.node + ' — ok');"

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
