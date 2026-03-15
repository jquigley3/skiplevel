#!/usr/bin/env bash
# Test: parent creates a fibonacci project, spawns children for tests + code, then runs tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PROJECT_DIR="/tmp/fib-project"
mkdir -p "$PROJECT_DIR"

PROMPT='You have access to the macro-claw task API via environment variables.

To create a sub-task:
  curl -s -X POST "$MC2_API_URL/api/tasks" \
    -H "Authorization: Bearer $MC2_JOB_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"prompt\": \"...\", \"project_dir\": \"/tmp/fib-project\"}"

To check a task status:
  curl -s "$MC2_API_URL/api/tasks/<TASK_ID>" \
    -H "Authorization: Bearer $MC2_JOB_TOKEN"

To list all your sub-tasks:
  curl -s "$MC2_API_URL/api/tasks" \
    -H "Authorization: Bearer $MC2_JOB_TOKEN"

Your goal:
1. Choose a language (Python is fine) and create a project outline for a fibonacci calculator using recursion. Create the directory structure and any config files (e.g. a simple README) in /workspace/project.
2. Spawn TWO sub-tasks:
   - Task A: "Write tests for a recursive fibonacci function. The project is in /workspace/project. Create a test file (e.g. test_fib.py) that tests fib(0)=0, fib(1)=1, fib(5)=5, fib(10)=55. Do not write the implementation."
   - Task B: "Write a recursive fibonacci implementation. The project is in /workspace/project. Create a module (e.g. fib.py) with a function fib(n) that returns the nth fibonacci number using recursion. Do not write tests."
3. Poll their status every 10 seconds until both are done.
4. Once both are done, run the tests (e.g. python -m pytest or python -m unittest) and report the results. Review the code briefly.'

"$SCRIPT_DIR/submit.sh" "$PROJECT_DIR" "$PROMPT" \
  --capabilities spawn_task \
  --allowed-paths "$PROJECT_DIR"

echo ""
echo "Monitor progress:  ./list.sh"
echo "Orchestrator logs: ./dev.sh logs"
