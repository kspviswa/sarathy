# Sarathy gateway — python:3.12-slim, non-root, volumes for data/config/extensions
FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY pyproject.toml README.md LICENSE ./
COPY sarathy/ sarathy/
RUN pip install --no-cache-dir .

# Runtime user (non-root)
RUN useradd --create-home --uid 1000 sarathy
RUN mkdir -p /data /config && chown -R sarathy:sarathy /app /data /config
USER sarathy

# Volumes: data (sessions/memory/cron), config, extensions under data
ENV SARATHY_HOME=/data
ENV SARATHY_CONFIG=/config/config.json

EXPOSE 18790

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:18790/api/health', timeout=4).status==200 else 1)" || exit 1

ENTRYPOINT ["sarathy", "gateway"]
CMD ["start", "--foreground"]