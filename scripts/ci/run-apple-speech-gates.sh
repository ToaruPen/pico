#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_dir="$root_dir/sidecars/apple-speech"
developer_dir="$(xcode-select -p)"
testing_frameworks="$developer_dir/Library/Developer/Frameworks"
testing_libraries="$developer_dir/Library/Developer/usr/lib"
temporary_dir="$(mktemp -d)"
build_dir="$temporary_dir/swift-build"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$temporary_dir"
}

fail() {
  printf 'Apple Speech gate failed: %s\n' "$1" >&2
  exit 1
}

trap cleanup EXIT

swift_test_arguments=(--scratch-path "$build_dir")
if [[ -d "$testing_frameworks/Testing.framework" || -f "$testing_libraries/lib_TestingInterop.dylib" ]]; then
  if [[ ! -d "$testing_frameworks/Testing.framework" ]]; then
    fail "Swift Testing framework was not found under the selected developer directory"
  fi
  if [[ ! -f "$testing_libraries/lib_TestingInterop.dylib" ]]; then
    fail "Swift Testing interoperability library was not found under the selected developer directory"
  fi
  swift_test_arguments+=(
    -Xswiftc -F -Xswiftc "$testing_frameworks"
    -Xlinker -F -Xlinker "$testing_frameworks"
    -Xlinker -rpath -Xlinker "$testing_frameworks"
    -Xlinker -rpath -Xlinker "$testing_libraries"
  )
fi

cd "$package_dir"

swift test "${swift_test_arguments[@]}"

swift build --scratch-path "$build_dir" -c release -Xswiftc -warnings-as-errors
binary_dir="$(swift build --scratch-path "$build_dir" -c release --show-bin-path)"
binary="$binary_dir/pico-apple-speech-sidecar"

version_output="$($binary --version)"
[[ "$version_output" == "pico-apple-speech-sidecar 0.1.0" ]] || fail "version output was unexpected"

if "$binary" unknown >"$temporary_dir/invalid.stdout" 2>"$temporary_dir/invalid.stderr"; then
  fail "invalid command line exited successfully"
fi
[[ ! -s "$temporary_dir/invalid.stdout" ]] || fail "invalid command line wrote to stdout"
grep -Fxq "pico-apple-speech-sidecar: invalid command line" "$temporary_dir/invalid.stderr" \
  || fail "invalid command line stderr was not sanitized"

port=$((20000 + ($$ % 30000)))
base_url="http://127.0.0.1:$port"
"$binary" serve \
  --host 127.0.0.1 \
  --port "$port" \
  --locale ja-JP \
  --analysis-timeout-ms 25000 \
  >"$temporary_dir/server.stdout" \
  2>"$temporary_dir/server.stderr" &
server_pid=$!

server_ready=false
for _ in {1..100}; do
  if curl --silent --show-error --fail --max-time 1 \
    "$base_url/health" >"$temporary_dir/health.json" 2>/dev/null; then
    server_ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    fail "server exited before the health check"
  fi
  sleep 0.05
done
[[ "$server_ready" == true ]] || fail "health endpoint did not become available"
grep -Fq '"status":"ok"' "$temporary_dir/health.json" || fail "health response was malformed"

ready_status="$(
  curl --silent --show-error --max-time 5 \
    --output "$temporary_dir/ready.json" \
    --write-out '%{http_code}' \
    "$base_url/ready"
)"
case "$ready_status" in
  200)
    grep -Fq '"ready":true' "$temporary_dir/ready.json" || fail "ready response was malformed"
    ;;
  503)
    grep -Fq '"code":"model_load"' "$temporary_dir/ready.json" \
      || fail "missing-asset readiness response was malformed"
    ;;
  *)
    fail "ready endpoint returned an unexpected status"
    ;;
esac

malformed_status="$(
  curl --silent --show-error --max-time 5 \
    --header 'content-type: application/json' \
    --data-binary '{' \
    --output "$temporary_dir/malformed.json" \
    --write-out '%{http_code}' \
    "$base_url/v1/transcriptions"
)"
[[ "$malformed_status" == 400 ]] || fail "malformed request did not return HTTP 400"
grep -Fq '"code":"invalid_request"' "$temporary_dir/malformed.json" \
  || fail "malformed request response was not invalid_request"

dd if=/dev/zero of="$temporary_dir/oversized.body" bs=1048576 count=6 2>/dev/null
oversized_status="$(
  curl --silent --show-error --max-time 10 \
    --header 'content-type: application/json' \
    --header 'expect:' \
    --data-binary "@$temporary_dir/oversized.body" \
    --output "$temporary_dir/oversized.json" \
    --write-out '%{http_code}' \
    "$base_url/v1/transcriptions"
)"
[[ "$oversized_status" == 413 ]] || fail "oversized request did not return HTTP 413"
grep -Fq '"code":"invalid_request"' "$temporary_dir/oversized.json" \
  || fail "oversized request response was not invalid_request"

printf 'Apple Speech gates passed.\n'
