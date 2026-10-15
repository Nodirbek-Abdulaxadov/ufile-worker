#!/usr/bin/env bash
# Download UFile's font pack into public/fonts/: open fonts with the metrics of the Office fonts,
# which the engines offer under the Office names and fetch on demand (fonts.json):
#
#   Arial           → Liberation Sans 2.1.5   (OFL-1.1)
#   Times New Roman → Liberation Serif 2.1.5  (OFL-1.1)
#   Courier New     → Liberation Mono 2.1.5   (OFL-1.1)
#   Calibri         → Carlito                 (OFL-1.1)
#   Cambria         → Caladea                 (OFL-1.1)
#
# The files are the upstream ones, unchanged, checked against the SHA-256 sums below.
#
#   scripts/fetch-fonts.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/fonts"

LIBERATION_URL="https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz"
LIBERATION_SHA="7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0"
LIBERATION_DIR="liberation-2.1.5"
# google/fonts revisions
CARLITO_REV="3dd78844021e948ceb633d1dcee3f7885561b5d9"
CALADEA_REV="13c010f766052c13fa9cc8c656008cee55fb4775"
CARLITO_DIR="carlito-${CARLITO_REV:0:7}"
CALADEA_DIR="caladea-${CALADEA_REV:0:7}"

die() { echo "error: $*" >&2; exit 1; }
command -v curl >/dev/null || die "curl not found"
command -v node >/dev/null || die "node not found (needed to precompress the fonts)"

check() { # file sha256
  echo "$2  $1" | sha256sum -c --quiet - || die "$1: checksum mismatch"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT/$LIBERATION_DIR" "$OUT/$CARLITO_DIR" "$OUT/$CALADEA_DIR"

echo "== Liberation 2.1.5"
curl -fsSL -o "$TMP/liberation.tar.gz" "$LIBERATION_URL"
check "$TMP/liberation.tar.gz" "$LIBERATION_SHA"
tar -xzf "$TMP/liberation.tar.gz" -C "$TMP"
for family in Sans Serif Mono; do
  for style in Regular Bold Italic BoldItalic; do
    cp "$TMP/liberation-fonts-ttf-2.1.5/Liberation$family-$style.ttf" "$OUT/$LIBERATION_DIR/"
  done
done
cp "$TMP/liberation-fonts-ttf-2.1.5/LICENSE" "$OUT/$LIBERATION_DIR/LICENSE.txt"

# name dir rev sha256 (Regular Bold Italic BoldItalic)
google() {
  local name=$1 dir=$2 rev=$3; shift 3
  local lower=${name,,} style
  echo "== $name (google/fonts@${rev:0:7})"
  for style in Regular Bold Italic BoldItalic; do
    curl -fsSL -o "$OUT/$dir/$name-$style.ttf" "https://raw.githubusercontent.com/google/fonts/$rev/ofl/$lower/$name-$style.ttf"
    check "$OUT/$dir/$name-$style.ttf" "$1"
    shift
  done
  curl -fsSL -o "$OUT/$dir/OFL.txt" "https://raw.githubusercontent.com/google/fonts/$rev/ofl/$lower/OFL.txt"
}
google Carlito "$CARLITO_DIR" "$CARLITO_REV" \
  f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595 \
  bb5d20f79b82599ec72983597437373a80f2d2085fa91fc144fd74e876a594db \
  0b019225e58d702bfedcbd35c21696769f8ee115cb6343f84c2f240312450d1c \
  b32928186c119599e03ca6a1ffc680fdcb7fac95772f4b95d989cf6cd3861517
google Caladea "$CALADEA_DIR" "$CALADEA_REV" \
  f1e899278b7b4491aba5b6a8253c4b04c050cc59b21865be5c37559a775153cd \
  ae3cb2dcbc925809dd29d2a44e9802211cab66be541bacbfc9c08c74b27c3742 \
  4359a8e24f748b6447b1ff6d7a174febe70961d29f8bb8634b56dacd740a3deb \
  ccabaa7b7e2fdf253d2b1a5fa699dd8a3df8d835a9eb285ad82631a677eb76c0

# The manifest the engines read: each Office family, the font standing in for it and its files.
family() { # office-name font dir prefix
  printf '    {"family": "%s", "font": "%s", "license": "OFL-1.1", "files": [' "$1" "$2"
  printf '"%s/%s-Regular.ttf", "%s/%s-Bold.ttf", "%s/%s-Italic.ttf", "%s/%s-BoldItalic.ttf"]}' "$3" "$4" "$3" "$4" "$3" "$4" "$3" "$4"
}
{
  echo '{'
  echo '  "families": ['
  family "Arial" "Liberation Sans" "$LIBERATION_DIR" LiberationSans; echo ','
  family "Times New Roman" "Liberation Serif" "$LIBERATION_DIR" LiberationSerif; echo ','
  family "Courier New" "Liberation Mono" "$LIBERATION_DIR" LiberationMono; echo ','
  family "Calibri" "Carlito" "$CARLITO_DIR" Carlito; echo ','
  family "Cambria" "Caladea" "$CALADEA_DIR" Caladea; echo
  echo '  ]'
  echo '}'
} >"$OUT/fonts.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$OUT/fonts.json" || die "fonts.json isn't JSON"

node "$ROOT/scripts/precompress.mjs" "$OUT" >/dev/null
echo "done: $OUT ($(du -sh "$OUT" | cut -f1))"
