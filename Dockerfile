FROM node:22-trixie-slim

WORKDIR /app

ARG TAG
ENV TAG=${TAG:-latest}

# Enable corepack, set PNPM_HOME and ensure pnpm is available
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install the CLI with allowed build scripts for native modules
RUN pnpm install -g \
    --allow-build=@ipshipyard/node-datachannel \
    --allow-build=better-sqlite3 \
    --allow-build=classic-level \
    --allow-build=protobufjs \
    @riffcc/lens-node@${TAG}

ENTRYPOINT ["lens-node"]