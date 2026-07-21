#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_dir="$root_dir/sidecars/macos-resident-io"
developer_dir="$(xcode-select -p)"
testing_frameworks="$developer_dir/Library/Developer/Frameworks"
testing_libraries="$developer_dir/Library/Developer/usr/lib"
temporary_dir="$(mktemp -d)"
build_dir="$temporary_dir/swift-build"

cleanup() {
  rm -rf "$temporary_dir"
}

trap cleanup EXIT

cd "$package_dir"

xcrun swift-format lint --recursive Sources Tests Package.swift

swift_test_arguments=(--scratch-path "$build_dir")
if [[ -d "$testing_frameworks/Testing.framework" ]]; then
  swift_test_arguments+=(
    -Xswiftc -F -Xswiftc "$testing_frameworks"
    -Xlinker -F -Xlinker "$testing_frameworks"
    -Xlinker -rpath -Xlinker "$testing_frameworks"
    -Xlinker -rpath -Xlinker "$testing_libraries"
  )
fi

swift test "${swift_test_arguments[@]}"
swift build --scratch-path "$build_dir" -c release -Xswiftc -warnings-as-errors

binary_dir="$(swift build --scratch-path "$build_dir" -c release --show-bin-path)"
binary="$binary_dir/pico-macos-resident-io"

if "$binary" --unknown >"$temporary_dir/invalid.stdout" 2>"$temporary_dir/invalid.stderr"; then
  printf 'macOS resident I/O gate failed: invalid command line exited successfully\n' >&2
  exit 1
fi

[[ ! -s "$temporary_dir/invalid.stdout" ]]
grep -Fq 'pico macOS resident I/O failed:' "$temporary_dir/invalid.stderr"

printf 'macOS resident I/O gates passed.\n'
