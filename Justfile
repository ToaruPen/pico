set shell := ["sh", "-cu"]

default:
  just --list

typecheck:
  npm run typecheck

lint:
  npm run lint

format:
  npm run format

test:
  npm run test

smoke-milestone:
  npm run smoke:milestone

smoke-camera-vlm-scene:
  npm run smoke:camera-vlm-scene

smoke-ollama-vlm:
  npm run smoke:ollama-vlm

smoke-camera-tapo:
  npm run smoke:camera-tapo

smoke-voice-providers:
  npm run smoke:voice-providers

smoke-embedding-sidecar:
  npm run smoke:embedding-sidecar

smoke-pi-runtime:
  npm run smoke:pi-runtime

resident-voice-launchd action:
  npm run resident:voice:launchd -- {{action}}

voice-status:
  npm run resident:voice:launchd -- status

voice-normal:
  npm run resident:voice:launchd -- install

voice-stop:
  npm run resident:voice:launchd -- stop

voice-dev:
  -npm run resident:voice:launchd -- stop
  npm run resident:voice:dev-terminal -- --terminal=terminal

voice-dev-kitty:
  -npm run resident:voice:launchd -- stop
  npm run resident:voice:dev-terminal -- --terminal=kitty

dev-session:
  npm run resident:voice:dev-terminal

resident-voice-dev-terminal:
  npm run resident:voice:dev-terminal

field-voice-echo-pickup:
  npm run field:voice-echo-pickup

field-resident-voice-deferred-rallies:
  npm run field:resident-voice-deferred-rallies

ast:
  npm run ast:test
  npm run ast

apple-speech-check:
  bash scripts/ci/run-apple-speech-gates.sh

check:
  if [ "$(uname -s)" = "Darwin" ]; then just apple-speech-check; fi
  npm run check

ci:
  npm run check:ci
