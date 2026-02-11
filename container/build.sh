#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Auto-detect runtime: use Docker if available, otherwise Apple Container
if command -v docker >/dev/null 2>&1; then
    RUNTIME="docker"
    BUILD_CMD="docker build"
    RUN_CMD="docker run"
elif command -v container >/dev/null 2>&1; then
    RUNTIME="container"
    BUILD_CMD="container build"
    RUN_CMD="container run"
else
    echo "Error: Neither Docker nor Apple Container is found"
    exit 1
fi

echo "Using runtime: ${RUNTIME}"
$BUILD_CMD -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | $RUN_CMD -i ${IMAGE_NAME}:${TAG}"
