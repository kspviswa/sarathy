FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# Install Python dependencies first (cached layer)
COPY pyproject.toml README.md LICENSE ./
RUN mkdir -p sarathy && touch sarathy/__init__.py && \
    uv pip install --system --system --no-cache . && \
    rm -rf sarathy

# Copy the full source and install
COPY sarathy/ sarathy/
RUN uv pip install --system --no-cache .

# Create config directory
RUN mkdir -p /root/.sarathy

# Gateway default port
EXPOSE 18790

ENTRYPOINT ["sarathy"]
CMD ["status"]
