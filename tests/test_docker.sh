#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

IMAGE_NAME="sarathy-test"

echo "=== Building Docker image ==="
docker build -t "$IMAGE_NAME" .

CFG_DIR=$(mktemp -d)
DATA_DIR=$(mktemp -d)

echo ""
echo "=== Generating config via 'sarathy setup' ==="
docker run --rm --entrypoint sarathy \
    -v "$CFG_DIR:/config" -v "$DATA_DIR:/data" \
    -e SARATHY_HOME=/data \
    "$IMAGE_NAME" setup --provider ollama --model llama3.2 \
    --config /config/config.json 2>&1 | tail -3

echo ""
echo "=== Running 'sarathy status' ==="
STATUS_OUTPUT=$(docker run --rm --entrypoint sarathy \
    -v "$CFG_DIR:/config" -v "$DATA_DIR:/data" \
    -e SARATHY_HOME=/data -e SARATHY_CONFIG=/config/config.json \
    "$IMAGE_NAME" status 2>&1) || true

echo "$STATUS_OUTPUT"

echo ""
echo "=== Validating output ==="
PASS=true

check() {
    if echo "$STATUS_OUTPUT" | grep -q "$1"; then
        echo "  PASS: found '$1'"
    else
        echo "  FAIL: missing '$1'"
        PASS=false
    fi
}

check "sarathy Status"
check "Config:"
check "Workspace:"
check "Model:"

echo ""
if $PASS; then
    echo "=== Status checks passed ==="
else
    echo "=== Some checks FAILED ==="
    exit 1
fi

echo ""
echo "=== Verifying gateway boots and serves health ==="
docker rm -f sarathy-docker-test 2>/dev/null || true

HEALTH_CODE=$(
    docker run -d --rm --name sarathy-docker-test \
        -p 18791:18790 \
        -v "$CFG_DIR:/config" \
        -v "$DATA_DIR:/data" \
        -e SARATHY_CONFIG=/config/config.json \
        -e SARATHY_HOME=/data \
        "$IMAGE_NAME" >/dev/null 2>&1 && \
    sleep 8 && \
    curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18791/api/health || echo "000"
)
docker rm -f sarathy-docker-test 2>/dev/null || true
rm -rf "$CFG_DIR" "$DATA_DIR"

if [ "$HEALTH_CODE" = "200" ]; then
    echo "  PASS: /api/health returned HTTP 200"
else
    echo "  FAIL: /api/health returned HTTP $HEALTH_CODE"
    PASS=false
fi

echo ""
if $PASS; then
    echo "=== All checks passed ==="
else
    echo "=== Some checks FAILED ==="
    exit 1
fi

# Cleanup
echo ""
echo "=== Cleanup ==="
docker rmi -f "$IMAGE_NAME" 2>/dev/null || true
echo "Done."
