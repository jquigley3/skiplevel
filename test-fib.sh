#!/usr/bin/env bash
# Test: parent creates a fibonacci project, spawns children for tests + code, then runs tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PROJECT_DIR="/tmp/fib-project"
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"

PROMPT='Your goal:
1. Create a project outline for a recursive fibonacci calculator in Python. Create a README in /tmp/fib-project.
2. Spawn TWO sub-tasks:
   - Task A: "Write tests for a recursive fibonacci function. The project is in /tmp/fib-project. Create test_fib.py that tests fib(0)=0, fib(1)=1, fib(5)=5, fib(10)=55. Do not write the implementation."
   - Task B: "Write a recursive fibonacci implementation. The project is in /tmp/fib-project. Create fib.py with a function fib(n) that returns the nth fibonacci number using recursion. Do not write tests."
   Both tasks should have project_dir set to "/tmp/fib-project".
3. Poll their status every 10 seconds until both are done or failed.
4. Once both are done, run the tests (python3 -m pytest test_fib.py) in /tmp/fib-project and report the results.'

"$SCRIPT_DIR/submit.sh" "$PROJECT_DIR" "$PROMPT" \
  --capabilities spawn_task \
  --allowed-paths "$PROJECT_DIR" \
  --append-system-prompt-file "$SCRIPT_DIR/developer/tools.md"

echo ""
echo "Monitor progress:  ./list.sh"
echo "Orchestrator logs: ./dev.sh logs"
