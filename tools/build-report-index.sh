#!/usr/bin/env bash
# Rebuilds the report indexes from whatever files exist on disk.
#
# Every immediate subfolder of reports/ is a category with its own page, so
# adding a category later means creating the folder and dropping reports in —
# this script needs no changes.
#
#   reports/
#     index.json                     <- catalog of categories (generated)
#     ai-insights/index.json         <- { reports: [ { date, file }, ... ] }
#     performance-test/index.json
#     health-report/index.json
#
# A report is any .html/.htm/.pdf file whose name contains a YYYY-MM-DD date,
# whatever the prefix. Newest first; when a date has several files the last one
# alphabetically wins.
#
#   ./tools/build-report-index.sh [reports-dir]
#
set -euo pipefail

REPORTS_DIR="${1:-reports}"
EXTS='html|htm|pdf'

[ -d "$REPORTS_DIR" ] || { echo "Missing folder: $REPORTS_DIR" >&2; exit 1; }

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Emits "date<TAB>filename" for one folder, newest date first, one row per date.
collect() {
  find "$1" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null \
    | grep -Ei "\.(${EXTS})$" \
    | grep -v '["\]' \
    | awk '{
        if (match($0, /[0-9]{4}-[0-9]{2}-[0-9]{2}/))
          printf "%s\t%s\n", substr($0, RSTART, RLENGTH), $0
      }' \
    | LC_ALL=C sort -r -t"$(printf '\t')" -k1,1 -k2,2 \
    | awk -F'\t' '!seen[$1]++'
}

cat_rows=""     # catalog lines, built as we go
total=0

for dir in "$REPORTS_DIR"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  rows="$(collect "$dir" || true)"
  count="$(printf '%s' "$rows" | grep -c . || true)"
  latest="$(printf '%s\n' "$rows" | head -n1 | cut -f1)"

  printf '%s\n' "$rows" | awk -F'\t' -v now="$NOW" -v cat="$name" '
    BEGIN {
      printf "{\n  \"generated\": \"%s\",\n  \"category\": \"%s\",\n  \"reports\": [\n", now, cat
    }
    NF { if (n++) printf ",\n"; printf "    { \"date\": \"%s\", \"file\": \"%s\" }", $1, $2 }
    END { if (n) printf "\n"; printf "  ]\n}\n" }
  ' > "$dir/index.json"

  if [ -n "$latest" ]; then
    cat_rows="${cat_rows}    { \"id\": \"${name}\", \"index\": \"${name}/index.json\", \"count\": ${count}, \"latest\": \"${latest}\" }"$'\n'
  else
    cat_rows="${cat_rows}    { \"id\": \"${name}\", \"index\": \"${name}/index.json\", \"count\": 0, \"latest\": null }"$'\n'
  fi

  total=$((total + count))
  echo "Wrote ${dir%/}/index.json ($count reports)"
done

{
  echo "{"
  echo "  \"generated\": \"$NOW\","
  echo "  \"categories\": ["
  printf '%s' "$cat_rows" | awk 'NF { if (n++) printf ",\n"; printf "%s", $0 } END { if (n) printf "\n" }'
  echo "  ]"
  echo "}"
} > "$REPORTS_DIR/index.json"

echo "Wrote $REPORTS_DIR/index.json ($total reports across all categories)"
