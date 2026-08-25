#!/usr/bin/env bash
# Rebuilds reports/index.json from whatever weekly files exist on disk.
# Run this right after dropping in each Friday's report.
#
#   ./tools/build-report-index.sh
#
set -euo pipefail

REPORTS_DIR="${1:-reports}"
PREFIX="weekly_qa_insights_"
EXT="html"
OUT="$REPORTS_DIR/index.json"

[ -d "$REPORTS_DIR" ] || { echo "Missing folder: $REPORTS_DIR" >&2; exit 1; }

dates=$(
  find "$REPORTS_DIR" -maxdepth 1 -type f -name "${PREFIX}*.${EXT}" -printf '%f\n' 2>/dev/null \
    | sed -E "s/^${PREFIX}([0-9]{4}-[0-9]{2}-[0-9]{2})\.${EXT}$/\1/" \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
    | sort -r
)

{
  echo "{"
  echo "  \"generated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"reports\": ["
  printf '%s\n' "$dates" | awk -v p="$PREFIX" -v e="$EXT" '
    NF {
      if (n++) printf ",\n";
      printf "    { \"date\": \"%s\", \"file\": \"%s%s.%s\" }", $0, p, $0, e;
    }
    END { if (n) printf "\n" }'
  echo "  ]"
  echo "}"
} > "$OUT"

echo "Wrote $OUT ($(printf '%s\n' "$dates" | grep -c . || true) reports)"