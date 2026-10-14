ARG BASE_IMAGE=ghcr.io/milind-soni/openmausbot:latest
FROM ${BASE_IMAGE}

USER root

# Ferramentas necessárias para acessar o Docker da VPS via SSH.
# Não instala nem inicia um daemon Docker dentro do container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        docker.io \
        openssh-client \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Engines de IA: Claude Code e OpenAI Codex
ARG ENGINES="@anthropic-ai/claude-code @openai/codex"
RUN if [ -n "$ENGINES" ]; then \
      npm install -g $ENGINES; \
    fi

# Grok CLI: versão fixada, usando o instalador oficial da xAI.
# Defina GROK_VERSION= vazio para não instalar.
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

# Executar OpenMausBot como usuário não privilegiado.
USER maus
