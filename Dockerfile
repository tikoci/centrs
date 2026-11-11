FROM oven/bun:1.4.4-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# Run as the base image's non-root `bun` user (user ID 1000). Its home is
# /home/bun, so centrs reads the CDB from `/home/bun/.config/tikoci/winbox.cdb`
# and settings from `/home/bun/.config/tikoci/centrs.env`: mount a host config
# directory at /home/bun/.config/tikoci (readable by user ID 1000). To put the
# CDB elsewhere, set CENTRS_CDB_FILE or pass --cdb-file; XDG_CONFIG_HOME moves
# only centrs.env, not the CDB. Before 0.2.0 the image ran as root and read
# `/root/.config/tikoci/`.
USER bun

CMD ["bun", "src/cli.ts", "--help"]
