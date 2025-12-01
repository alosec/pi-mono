#!/bin/bash
# Start Zip agent in a named tmux session
SESSION="zip"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill existing session if present
tmux has-session -t $SESSION 2>/dev/null && tmux kill-session -t $SESSION

# Start new detached session running run.sh
tmux new-session -d -s $SESSION -c "$SCRIPT_DIR" './run.sh'

echo "Started $SESSION agent"
echo "Attach with: tmux attach -t $SESSION"
