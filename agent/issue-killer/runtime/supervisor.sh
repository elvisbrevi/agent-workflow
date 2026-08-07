#!/usr/bin/env bash
# Worker process supervision, streaming, and progress heartbeats.
# Sourced by run.sh; intentionally has no source-time side effects.

run_worker_with_progress() {
  local prompt="$1"
  local output_file="$2"
  local session_id="${3:-}"
  local exit_file="${output_file}.exit"
  local touch_file="${output_file}.touch"
  local lock_failure_file="${output_file}.lock-failure"
  local stream_fifo="${output_file}.fifo"
  local pipeline_pid sink_pid heartbeat_pid=""
  local started_at now elapsed pipeline_exit sink reason

  started_at="$(date +%s)"
  rm -f "$touch_file" "$exit_file" "$lock_failure_file" "$stream_fifo" "${output_file}.session"
  write_lock_status "worker_running" 0

  if [[ "$STREAM_OUTPUT" == "true" ]]; then
    sink=runtime_render_stream
  else
    sink=tee
  fi

  mkfifo "$stream_fifo" || \
    die "unable to create worker output pipe: ${stream_fifo}"
  LOCK_FAILURE_FILE="$lock_failure_file"
  LOCK_FAILURE_DEFER_CHECKPOINT=true
  {
    set +e
    runtime_invoke "$prompt" "$session_id" &
    worker_pid=$!
    trap 'kill "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; exit 143' HUP INT TERM
    wait "$worker_pid"
    worker_exit=$?
    trap - HUP INT TERM
    printf '%s\n' "$worker_exit" > "$exit_file"
  } > "$stream_fifo" 2>&1 &
  pipeline_pid=$!
  LOCK_FAILURE_PID="$pipeline_pid"
  "$sink" "$output_file" < "$stream_fifo" &
  sink_pid=$!

  if [[ "$PROGRESS_INTERVAL" -gt 0 ]]; then
    (
      while sleep "$PROGRESS_INTERVAL"; do
        kill -0 "$pipeline_pid" 2>/dev/null || exit 0
        now="$(date +%s)"
        elapsed=$((now - started_at))
        write_lock_status "worker_running" "$elapsed"
        # Suppress the heartbeat while the stream is still producing events.
        if [[ "$STREAM_OUTPUT" == "true" && -e "$touch_file" ]]; then
          : > "$touch_file"
          continue
        fi
        printf '\n[%s] Worker %s still running (elapsed %ss; live output above).\n' \
          "$RUNNER_NAME" "$ITERATION" "$elapsed"
      done
    ) &
    heartbeat_pid=$!
  fi

  set +e
  wait "$pipeline_pid"
  pipeline_exit=$?
  wait "$sink_pid"
  set -e

  if [[ -n "$heartbeat_pid" ]]; then
    kill "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
  fi

  if [[ -s "$lock_failure_file" ]]; then
    reason="$(<"$lock_failure_file")"
    rm -f "$lock_failure_file" "$stream_fifo"
    LOCK_FAILURE_DEFER_CHECKPOINT=false
    lock_integrity_failure "$reason"
  fi

  now="$(date +%s)"
  elapsed=$((now - started_at))
  if [[ -r "$exit_file" ]]; then
    WORKER_EXIT="$(<"$exit_file")"
  else
    WORKER_EXIT="$pipeline_exit"
  fi
  rm -f "$exit_file" "$touch_file" "$lock_failure_file" "$stream_fifo"
  LOCK_FAILURE_FILE=""
  LOCK_FAILURE_PID=""
  LOCK_FAILURE_DEFER_CHECKPOINT=false
  write_lock_status "worker_finished" "$elapsed"
  printf '[%s] Worker %s exited after %ss (code %s).\n' \
    "$RUNNER_NAME" "$ITERATION" "$elapsed" "$WORKER_EXIT"
}
