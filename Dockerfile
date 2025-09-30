FROM node:22-trixie-slim

WORKDIR /app

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

# Copy package files and lockfile
COPY package.json pnpm-lock.yaml ./

# Install dependencies locally
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build

ENTRYPOINT ["node", "dist/cli/bin.js"]