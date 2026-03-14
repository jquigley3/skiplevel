#!/usr/bin/env bash
# Build the agent-harness container image
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="agent-harness"

echo "Building $IMAGE_NAME container..."
docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"
echo "Done. Image: $IMAGE_NAME"
