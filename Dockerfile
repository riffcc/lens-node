FROM node:22-alpine

WORKDIR /app

ARG TAG
ENV TAG=${TAG:-latest}

# Enable corepack, set PNPM_HOME and ensure pnpm is available
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install the CLI
RUN pnpm install -g --dangerously-allow-all-builds @riffcc/lens-node@${TAG}

ENTRYPOINT ["lens-node"]