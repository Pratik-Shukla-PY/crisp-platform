#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$DIR/.crisp.pids"

echo "Stopping CRISP servers..."

if [ -f "$PID_FILE" ]; then
    while IFS= read -r pid; do
        if kill "$pid" 2>/dev/null; then
            echo "  Stopped PID $pid"
        fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
fi

# Belt-and-braces: also free the ports
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:8080 | xargs kill -9 2>/dev/null

echo "Done."
