FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

ARG compiler_lock_sha256
LABEL org.edastack.project-sandbox="tscircuit-v1"
LABEL org.edastack.compiler-lock-sha256=${compiler_lock_sha256}

ENV NODE_ENV=production
WORKDIR /opt/eda/compiler

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY src ./src
RUN mkdir -p /opt/eda/compiler/projects/input && chown -R 65532:65532 /opt/eda/compiler

USER 65532:65532
ENTRYPOINT ["node", "--import", "tsx", "/opt/eda/compiler/src/sandbox-runner.ts"]
