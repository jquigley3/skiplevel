#!/usr/bin/env bash
# Project permissions and approval queue for scoped permissions.
# Usage:
#   ./permissions.sh pending                           # list pending requests
#   ./permissions.sh approve <request-id> [--duration <min>]
#   ./permissions.sh deny <request-id> [--reason "..."]
#   ./permissions.sh project-add --project <dir> --token <name> [--can-delegate] --duration <min>
#   ./permissions.sh project-list
#   ./permissions.sh project-remove <id>
set -euo pipefail

MC2_API="${MC2_API_URL:-http://localhost:3001}"

die() { echo "ERROR: $*" >&2; exit 1; }

case "${1:-}" in
  project-add)
    shift
    PROJECT=""
    TOKEN=""
    CAN_DELEGATE="false"
    DURATION=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --project)     PROJECT="$2"; shift 2 ;;
        --token)      TOKEN="$2"; shift 2 ;;
        --can-delegate) CAN_DELEGATE="true"; shift ;;
        --duration)   DURATION="$2"; shift 2 ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
      esac
    done
    [[ -n "$PROJECT" ]] || die "Missing --project"
    [[ -n "$TOKEN" ]] || die "Missing --token"
    [[ -n "$DURATION" ]] || die "Missing --duration"
    [[ "$DURATION" =~ ^[0-9]+$ ]] || die "Duration must be a positive integer"

    # Resolve token name to id
    TOKENS=$(curl -s "$MC2_API/api/tokens")
    TOKEN_ID=$(echo "$TOKENS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for t in data.get('tokens', []):
    if t.get('name') == sys.argv[1]:
        print(t['id'])
        break
" "$TOKEN")
    [[ -n "$TOKEN_ID" ]] || die "Token not found: $TOKEN"

    BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'project_dir': sys.argv[1],
    'token_id': sys.argv[2],
    'can_delegate': sys.argv[3] == 'true',
    'duration_minutes': int(sys.argv[4]),
}))
" "$PROJECT" "$TOKEN_ID" "$CAN_DELEGATE" "$DURATION")

    RESP=$(curl -s -X POST "$MC2_API/api/project-permissions" -H "Content-Type: application/json" -d "$BODY")
    ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    if [[ -n "$ID" ]]; then
      echo "Project permission added: $PROJECT -> $TOKEN ($ID)"
    else
      echo "Error: $RESP" >&2
      exit 1
    fi
    ;;
  project-list)
    curl -s "$MC2_API/api/project-permissions" | python3 -m json.tool
    ;;
  project-remove)
    ID="${2:?Usage: ./permissions.sh project-remove <id>}"
    RESP=$(curl -s -X DELETE "$MC2_API/api/project-permissions/$ID")
    if echo "$RESP" | python3 -c "import sys,json; sys.exit(0 if json.load(sys.stdin).get('status')=='deleted' else 1)" 2>/dev/null; then
      echo "Project permission removed: $ID"
    else
      echo "Error: $RESP" >&2
      exit 1
    fi
    ;;
  pending)
    curl -s "$MC2_API/api/permissions/requests?status=pending" | python3 -m json.tool
    ;;
  approve)
    REQ_ID="${2:?Usage: ./permissions.sh approve <request-id> [--duration <min>]}"
    shift 2
    DURATION=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --duration) DURATION="$2"; shift 2 ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
      esac
    done
    BODY="{}"
    [[ -n "$DURATION" ]] && BODY=$(python3 -c "import json; print(json.dumps({'duration_minutes': int('$DURATION')}))")
    RESP=$(curl -s -X POST "$MC2_API/api/permissions/requests/$REQ_ID/approve" -H "Content-Type: application/json" -d "$BODY")
    if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('status')=='approved' else 1)" 2>/dev/null; then
      PERM_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('permission_id',''))" 2>/dev/null)
      echo "Request approved (permission: $PERM_ID)"
    else
      echo "Error: $RESP" >&2
      exit 1
    fi
    ;;
  deny)
    REQ_ID="${2:?Usage: ./permissions.sh deny <request-id> [--reason \"...\"]}"
    shift 2
    REASON=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --reason) REASON="$2"; shift 2 ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
      esac
    done
    BODY="{}"
    [[ -n "$REASON" ]] && BODY=$(python3 -c "import json,sys; print(json.dumps({'reason': sys.argv[1]}))" "$REASON")
    RESP=$(curl -s -X POST "$MC2_API/api/permissions/requests/$REQ_ID/deny" -H "Content-Type: application/json" -d "$BODY")
    if echo "$RESP" | python3 -c "import sys,json; sys.exit(0 if json.load(sys.stdin).get('status')=='denied' else 1)" 2>/dev/null; then
      echo "Request denied"
    else
      echo "Error: $RESP" >&2
      exit 1
    fi
    ;;
  *)
    echo "Usage: ./permissions.sh <command> [args]"
    echo "  pending         List pending permission requests"
    echo "  approve         Approve request (--duration to override)"
    echo "  deny            Deny request (--reason for message)"
    echo "  project-add     Add project auto-grant (--project, --token, [--can-delegate], --duration)"
    echo "  project-list    List project permissions"
    echo "  project-remove  Remove project permission by id"
    exit 1
    ;;
esac
