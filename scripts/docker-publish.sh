#!/usr/bin/env bash
# Build the Docker image on this machine and push it to Docker Hub (no CI needed).
#
#   scripts/docker-publish.sh                              # <version> and latest
#   IMAGE=someone/ufile-worker scripts/docker-publish.sh   # another repository
#
# Needs `docker login`, the engines built into public/engines/ (scripts/build-engines.sh) and the
# font pack in public/fonts/ (scripts/fetch-fonts.sh): the image takes them as they are. The
# version is package.json's.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-nbkabdulaxadov/ufile-worker}"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"

die() { echo "error: $*" >&2; exit 1; }

[ -n "$VERSION" ] || die "no version in package.json"
for id in pdf word excel slides; do
  [ -f "$ROOT/public/engines/$id/index.html" ] || die "the $id engine isn't built (scripts/build-engines.sh $id)"
done
[ -f "$ROOT/public/fonts/fonts.json" ] || die "the font pack is missing (scripts/fetch-fonts.sh)"

docker build -t "$IMAGE:$VERSION" -t "$IMAGE:latest" "$ROOT"
docker push "$IMAGE:$VERSION"
docker push "$IMAGE:latest"
echo "pushed $IMAGE:$VERSION and $IMAGE:latest"
# The Docker Hub page (docker/README.md, docker/hub.json): a failure here leaves the image pushed.
node "$ROOT/scripts/dockerhub-meta.mjs" || echo "warning: the Docker Hub page was not updated" >&2
