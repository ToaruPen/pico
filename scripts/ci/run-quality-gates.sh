#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

declare -a gate_names=(
  "typecheck"
  "lint"
  "ast-rules"
  "ast-scan"
  "format"
  "test"
)

declare -a gate_pids=()

run_gate() {
  local name="$1"
  local log_file="$tmp_dir/$name.log"

  {
    case "$name" in
      typecheck)
        printf 'command: npm run typecheck\n\n'
        npm run typecheck
        ;;
      lint)
        printf 'command: npm run lint\n\n'
        npm run lint
        ;;
      ast-rules)
        printf 'command: npm run ast:test\n\n'
        npm run ast:test
        ;;
      ast-scan)
        printf 'command: npm run ast\n\n'
        npm run ast
        ;;
      format)
        printf 'command: npm run format:check\n\n'
        npm run format:check
        ;;
      test)
        printf 'command: npm run test\n\n'
        npm run test
        ;;
      *)
        printf 'Unknown gate: %s\n' "$name" >&2
        exit 2
        ;;
    esac
  } >"$log_file" 2>&1
}

for name in "${gate_names[@]}"; do
  run_gate "$name" &
  gate_pids+=("$!")
done

failed=0

for index in "${!gate_names[@]}"; do
  name="${gate_names[$index]}"
  pid="${gate_pids[$index]}"
  log_file="$tmp_dir/$name.log"

  if wait "$pid"; then
    printf '::group::%s passed\n' "$name"
    cat "$log_file"
    printf '::endgroup::\n'
  else
    status="$?"
    failed=1
    printf '::group::%s failed\n' "$name"
    cat "$log_file"
    printf '::endgroup::\n'
    printf 'Gate %s failed with exit code %s.\n' "$name" "$status" >&2
  fi
done

exit "$failed"
