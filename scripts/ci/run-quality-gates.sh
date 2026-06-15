#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

export PATH="$PWD/node_modules/.bin:$PATH"

declare -a gate_names=(
  "typecheck"
  "lint"
  "ast-rules"
  "ast-scan"
  "format"
  "test"
)

declare -a gate_pids=()

gate_command_label() {
  local name="$1"

  case "$name" in
    typecheck)
      printf 'tsc --noEmit\n'
      ;;
    lint)
      printf 'eslint .\n'
      ;;
    ast-rules)
      printf 'ast-grep test --config sgconfig.yml --skip-snapshot-tests\n'
      ;;
    ast-scan)
      printf 'ast-grep scan --config sgconfig.yml src tests\n'
      ;;
    format)
      printf 'biome ci .\n'
      ;;
    test)
      printf 'vitest run\n'
      ;;
    *)
      printf 'unknown\n'
      ;;
  esac
}

run_gate() {
  local name="$1"
  local log_file="$tmp_dir/$name.log"
  local status_file="$tmp_dir/$name.status"
  local duration_file="$tmp_dir/$name.duration"
  local started_at
  local completed_at
  local status

  started_at="$(date +%s)"

  set +e

  {
    printf 'command: %s\n\n' "$(gate_command_label "$name")"

    case "$name" in
      typecheck) tsc --noEmit ;;
      lint) eslint . ;;
      ast-rules) ast-grep test --config sgconfig.yml --skip-snapshot-tests ;;
      ast-scan) ast-grep scan --config sgconfig.yml src tests ;;
      format) biome ci . ;;
      test) vitest run ;;
      *)
        printf 'Unknown gate: %s\n' "$name" >&2
        status=2
        ;;
    esac
  } >"$log_file" 2>&1

  status="${status:-$?}"
  completed_at="$(date +%s)"
  printf '%s\n' "$status" >"$status_file"
  printf '%s\n' "$((completed_at - started_at))" >"$duration_file"

  set -e
  return "$status"
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
    duration="$(cat "$tmp_dir/$name.duration" 2>/dev/null || printf '?')"
    printf '::group::%s passed (%ss)\n' "$name" "$duration"
    cat "$log_file"
    printf '::endgroup::\n'
  else
    status="$?"
    duration="$(cat "$tmp_dir/$name.duration" 2>/dev/null || printf '?')"
    failed=1
    printf '::group::%s failed (%ss)\n' "$name" "$duration"
    cat "$log_file"
    printf '::endgroup::\n'
    printf 'Gate %s failed with exit code %s.\n' "$name" "$status" >&2
  fi
done

{
  printf 'Quality gate summary:\n'
  printf '\n'
  printf '| Gate | Status | Duration |\n'
  printf '| --- | --- | ---: |\n'

  for name in "${gate_names[@]}"; do
    status="$(cat "$tmp_dir/$name.status" 2>/dev/null || printf '?')"
    duration="$(cat "$tmp_dir/$name.duration" 2>/dev/null || printf '?')"

    if [[ "$status" == "0" ]]; then
      label="passed"
    else
      label="failed ($status)"
    fi

    printf '| %s | %s | %ss |\n' "$name" "$label" "$duration"
  done
} | tee "$tmp_dir/summary.md"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$tmp_dir/summary.md" >>"$GITHUB_STEP_SUMMARY"
fi

exit "$failed"
