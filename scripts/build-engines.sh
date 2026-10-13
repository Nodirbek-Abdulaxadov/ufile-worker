#!/usr/bin/env bash
# Build the four document engines (engines/<name>/, Rust) for the browser and install them in
# public/engines/<id>/.
#
#   scripts/build-engines.sh                 # all four: pdf word excel slides
#   scripts/build-engines.sh word excel      # only these
#
# Needs Rust with the wasm32-unknown-unknown target and trunk:
#   rustup target add wasm32-unknown-unknown
#   cargo install trunk --locked
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/engines"
OUT="$ROOT/public/engines"

# id | source folder | web app crate
ENGINES=(
  "pdf|pdfcraft|pdfcraft-web"
  "word|wordcraft|wordcraft-web"
  "excel|gridcraft|gridcraft-web"
  "slides|deckcraft|deckcraft-web"
)

die() { echo "error: $*" >&2; exit 1; }

command -v trunk >/dev/null || die "trunk not found (cargo install trunk --locked)"
command -v node >/dev/null || die "node not found (needed to precompress the engines)"
rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown ||
  die "the wasm32 target is missing (rustup target add wasm32-unknown-unknown)"

selected=("$@")
wanted() {
  [ ${#selected[@]} -eq 0 ] && return 0
  local id
  for id in "${selected[@]}"; do [ "$id" = "$1" ] && return 0; done
  return 1
}

mkdir -p "$OUT"
for entry in "${ENGINES[@]}"; do
  IFS='|' read -r id name crate <<<"$entry"
  wanted "$id" || continue
  dir="$SRC/$name"
  [ -d "$dir/apps/$crate" ] || die "$dir/apps/$crate not found"
  echo "== $id: engines/$name/apps/$crate"
  started=$(date +%s)
  (cd "$dir/apps/$crate" && trunk build --release --dist "$OUT/$id" --public-url ./)
  [ -f "$OUT/$id/index.html" ] || die "trunk left no $OUT/$id/index.html"
  # Relative URLs only, so the engine works under any path.
  if grep -Eq '(src|href)="/[^/]' "$OUT/$id/index.html"; then
    die "$OUT/$id/index.html has root-absolute URLs"
  fi
  # The licences and notices travel with the built engine (MIT / Apache-2.0 ask for that).
  cp "$dir/LICENSE-MIT" "$dir/LICENSE-APACHE" "$dir/NOTICE" "$dir/ATTRIBUTION.md" "$OUT/$id/"
  node "$ROOT/scripts/precompress.mjs" "$OUT/$id"
  version=$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$dir/Cargo.toml" | head -1)
  printf '{"id":"%s","engine":"%s","version":"%s","built":"%s"}\n' \
    "$id" "$name" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$OUT/$id/engine.json"
  echo "  built in $(( $(date +%s) - started ))s: $(du -sh "$OUT/$id" | cut -f1)"
done
echo "done: $OUT"
