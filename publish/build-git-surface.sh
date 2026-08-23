#!/bin/sh
# build-git-surface.sh — costruisce l'albero da pubblicare sul repository
# pubblico, applicando git-surface-exclude.txt.
#
#   build-git-surface.sh <tree-ish> <out-dir>
#
# L'uscita non deve esistere: un albero mescolato a una pubblicazione
# precedente e' indistinguibile da uno costruito adesso.
#
# NOTA sul confine, perche' il nome non lo dice: i FILE vengono dal tree-ish,
# l'ELENCO DI ESCLUSIONE dalla copia di lavoro. Due esecuzioni sullo stesso
# tree-ish possono quindi differire se l'elenco e' cambiato in mezzo.
set -eu

[ "$#" -eq 2 ] || { echo "uso: build-git-surface.sh <tree-ish> <out-dir>" >&2; exit 2; }
TREEISH=$1
OUT=$2
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LISTA="$DIR/git-surface-exclude.txt"
[ -f "$LISTA" ] || { echo "elenco assente: $LISTA" >&2; exit 2; }
[ ! -e "$OUT" ] || { echo "l'uscita esiste gia': $OUT" >&2; exit 2; }

mkdir -p "$OUT"
git archive --format=tar "$TREEISH" | tar -x -C "$OUT"

tolti=0
while IFS= read -r p; do
  case "$p" in ''|'#'*) continue ;; esac
  case "$p" in
    */) [ -d "$OUT/${p%/}" ] && { n=$(find "$OUT/${p%/}" -type f | wc -l); rm -rf "$OUT/${p%/}"; tolti=$((tolti+n)); } ;;
    *)  [ -f "$OUT/$p" ] && { rm -f "$OUT/$p"; tolti=$((tolti+1)); } ;;
  esac
done < "$LISTA"

echo "build-git-surface: $(find "$OUT" -type f | wc -l) file pubblicabili, $tolti tolti da $TREEISH"
