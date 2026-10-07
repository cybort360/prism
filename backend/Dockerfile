# Prism backend — production container for Fly.io (or any Docker host).
# Node 22 (package.json engines: ">=22"). No native deps, so slim is fine.
FROM node:22-slim

WORKDIR /app

# Install prod deps first for layer caching. `npm ci` needs package-lock.json (committed).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY src ./src

# The JSON store lives on a mounted volume so it survives deploys/restarts (see fly.toml [mounts]).
ENV STORE_PATH=/data/store.json \
    PORT=8787
EXPOSE 8787

CMD ["node", "src/server.js"]
