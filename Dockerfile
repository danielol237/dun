# Dun runs on a single Node process with no native dependencies — sql.js is
# WebAssembly, so there is no build step and no toolchain in the image.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a code change does not invalidate the install layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# The ledger lives here. On a host with an ephemeral disk this directory is
# rebuilt from the encrypted snapshot in DUN_BACKUP_REPO at every boot, so it is
# a cache as much as a store.
RUN mkdir -p data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.mjs"]
