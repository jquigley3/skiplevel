#!/usr/bin/env bash
# Token registry for scoped permissions.
# Usage:
#   ./tokens.sh add --name <name> --url-pattern <regex> --header <name> --value <secret> [--description <text>] [--project <dir>]
#   ./tokens.sh list [--project <dir>]
#   ./tokens.sh remove <id-or-name>
set -euo pipefail

MC2_API="${MC2_API_URL:-http://localhost:3001}"

die() { echo "ERROR: $*" >&2; exit 1; }

case "${1:-}" in
  add)
    shift
    NAME=""
    URL_PATTERN=""
    HEADER=""
    VALUE=""
    DESCRIPTION=""
    PROJECT=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name)         NAME="$2"; shift 2 ;;
        --url-pattern) URL_PATTERN="$2"; shift 2 ;;
        --header)      HEADER="$2"; shift 2 ;;
        --value)       VALUE="$2"; shift 2 ;;
        --description) DESCRIPTION="$2"; shift 2 ;;
        --project)     PROJECT="$2"; shift 2 ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
      esac
    done
    [[ -n "$NAME" ]] || die "Missing --name"
    [[ -n "$URL_PATTERN" ]] || die "Missing --url-pattern"
    [[ -n "$HEADER" ]] || die "Missing --header"
    [[ -n "$VALUE" ]] || die "Missing --value"

    BODY=$(python3 -c "
import json, sys
d = {
    'name': sys.argv[1],
    'url_pattern': sys.argv[2],
    'inject_header': sys.argv[3],
    'inject_value': sys.argv[4],
}
if sys.argv[5]: d['description'] = sys.argv[5]
if sys.argv[6]: d['project_dir'] = sys.argv[6]
print(json.dumps(d))
" "$NAME" "$URL_PATTERN" "$HEADER" "$VALUE" "$DESCRIPTION" "$PROJECT")

    RESP=$(curl -s -X POST "$MC2_API/api/tokens" -H "Content-Type: application/json" -d "$BODY")
    ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    if [[ -n "$ID" ]]; then
      echo "Token registered: $NAME ($ID)"
    else
      echo "Error: $RESP" >&2
      exit 1
    fi
    ;;
  list)
    shift
    PROJECT=""
    [[ "${1:-}" = "--project" ]] && { PROJECT="$2"; shift 2; }
    URL="$MC2_API/api/tokens"
    [[ -n "$PROJECT" ]] && URL="${URL}?project_dir=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PROJECT'))")"
    curl -s "$URL" | python3 -m json.tool
    ;;
  remove)
    ID_OR_NAME="${2:?Usage: ./tokens.sh remove <id-or-name>}"
    RESP=$(curl -s -X DELETE "$MC2_API/api/tokens/$ID_OR_NAME")
    if echo "$RESP" | python3 -c "import sys,json; sys.exit(0 if json.load(sys.stdin).get('status')=='deleted' else 1)" 2>/dev/null; then
      echo "Token removed: $ID_OR_NAME"
    else
      echo "Error: $RESP" >&2
      exit 1
    fi
    ;;
  *)
    echo "Usage: ./tokens.sh <command> [args]"
    echo "  add     Register a token (--name, --url-pattern, --header, --value, [--description], [--project])"
    echo "  list    List tokens [--project <dir>]"
    echo "  remove  Remove token by id or name"
    exit 1
    ;;
esac
