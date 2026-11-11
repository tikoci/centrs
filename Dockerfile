FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# Run as the base image's non-root `bun` user (user ID 1000). centrs reads its
# CDB and settings from `$XDG_CONFIG_HOME/tikoci/`, which defaults to
# `/home/bun/.config/tikoci/` here: mount a host config directory there (it
# must be readable by user ID 1000), or set XDG_CONFIG_HOME, CENTRS_CDB_FILE or
# --cdb-file to point elsewhere. Before 0.2.0 the image ran as root and read
# `/root/.config/tikoci/`.
USER bun

CMD ["bun", "src/cli.ts", "--help"]
