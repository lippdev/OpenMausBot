ARG BASE_IMAGE=ghcr.io/milind-soni/openmausbot:latest
FROM ${BASE_IMAGE}

USER root

# Dependências para conexão SSH e instalação do Docker CLI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-client \
        ca-certificates \
        curl \
        tar \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI 29.1.3
# Instala apenas o cliente, sem Docker daemon.
ARG DOCKER_VERSION=29.1.3
ARG TARGETARCH

RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) DOCKER_ARCH="x86_64" ;; \
      arm64) DOCKER_ARCH="aarch64" ;; \
      *) echo "Arquitetura Docker não suportada: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    curl -fsSL \
      "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz" \
      -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker /tmp/docker.tgz; \
    docker --version

# Engines de IA: Claude Code e OpenAI Codex.
ARG ENGINES="@anthropic-ai/claude-code @openai/codex"

RUN if [ -n "$ENGINES" ]; then \
      npm install -g $ENGINES; \
    fi

# Grok CLI: versão fixada, usando o instalador oficial da xAI.
# Defina GROK_VERSION vazio para não instalar.
ARG GROK_VERSION=1.0.41

RUN if [ -n "$GROK_VERSION" ]; then \
      mkdir -p /tmp/grok-install \
      && curl -fsSL https://x.ai/cli/install.sh \
           -o /tmp/grok-install/install.sh \
      && HOME=/tmp/grok-install \
         PATH="/tmp/grok-install/.grok/bin:$PATH" \
         bash /tmp/grok-install/install.sh "$GROK_VERSION" \
      && install -m 0755 \
           "$(readlink -f /tmp/grok-install/.grok/bin/grok)" \
           /usr/local/bin/grok \
      && HOME=/tmp/grok-install grok --version \
           | grep -qF "grok $GROK_VERSION " \
      && rm -rf /tmp/grok-install; \
    fi

# Executa o OpenMausBot sem privilégios de root.
USER maus
