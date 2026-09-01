#!/bin/sh
# Deletion-only public-tree builder. The verifier receives the exact staged
# object and writes a detached manifest only after the object equation passes.
set -eu

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || { echo "uso: build-git-surface.sh <commit-sha> <out-dir> [manifest]" >&2; exit 2; }
TREEISH=$1
OUT=$2
MANIFEST=${3:-${OUT}.manifest.json}
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LISTA="$DIR/git-surface-exclude.txt"
VERIFIER="$DIR/verify-git-surface.js"
RULES="$DIR/public-surface-rules.json"

case "$TREEISH" in *[!0-9a-fA-F]*|'') echo "source SHA non valido: $TREEISH" >&2; exit 2 ;; esac
[ "${#TREEISH}" -eq 40 ] || { echo "source SHA deve essere completo (40 hex)" >&2; exit 2; }
[ -f "$LISTA" ] || { echo "exclude-list assente: $LISTA" >&2; exit 2; }
[ -f "$VERIFIER" ] || { echo "verifier assente: $VERIFIER" >&2; exit 2; }
[ -f "$RULES" ] || { echo "rule bundle assente: $RULES" >&2; exit 2; }
[ ! -e "$OUT" ] || { echo "l'uscita esiste gia': $OUT" >&2; exit 2; }
[ ! -e "$MANIFEST" ] || { echo "il manifest esiste gia': $MANIFEST" >&2; exit 2; }

RESOLVED=$(git rev-parse --verify "$TREEISH^{commit}")
[ "$RESOLVED" = "$TREEISH" ] || { echo "source SHA non risolve allo stesso commit: $RESOLVED" >&2; exit 2; }

PARENT=$(CDPATH= cd -- "$(dirname -- "$OUT")" && pwd)
TMP=$(mktemp -d "$PARENT/.nexuscrew-public.XXXXXX")
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT HUP INT TERM
mkdir "$TMP/tree"
cp -- "$LISTA" "$TMP/exclude.txt"
cp -- "$VERIFIER" "$TMP/verifier.js"
cp -- "$RULES" "$TMP/rules.json"
cp -- "$0" "$TMP/builder.sh"
printf '%s\0' "$0" "$@" > "$TMP/invocation.argv"

git archive --format=tar "$TREEISH" | tar -x -C "$TMP/tree"

while IFS= read -r p; do
  case "$p" in ''|'#'*) continue ;; esac
  case "$p" in
    /*|*\\*|*..*|*\**|*\?*|*\[*|*\]*|.*) echo "regola exclude non sicura: $p" >&2; exit 2 ;;
    */) target="$TMP/tree/${p%/}"; [ -d "$target" ] && rm -rf -- "$target" ;;
    *)  target="$TMP/tree/$p"; [ ! -e "$target" ] && [ ! -L "$target" ] || rm -f -- "$target" ;;
  esac
done < "$TMP/exclude.txt"

SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0}; export SOURCE_DATE_EPOCH
NEXUSCREW_SOURCE_REPO=${NEXUSCREW_SOURCE_REPO:-DioNanos/nexuscrew}; export NEXUSCREW_SOURCE_REPO
# Execute the verified copy, but attest the canonical checkout objects.  This
# keeps the manifest provenance stable and makes a substituted temp input
# observable by its blob/hash fields.
node "$TMP/verifier.js" "$TREEISH" "$TMP/tree" "$TMP/manifest.json" "$LISTA" "$0" "$RULES" "$VERIFIER" "$TMP/invocation.argv"

mkdir -p -- "$(dirname -- "$MANIFEST")"
mv -- "$TMP/tree" "$OUT"
mv -- "$TMP/manifest.json" "$MANIFEST"
echo "build-git-surface: verified deletion-only tree=$OUT manifest=$MANIFEST"
