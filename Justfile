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

smoke-pi-runtime:
  npm run smoke:pi-runtime

ast:
  npm run ast:test
  npm run ast

check:
  npm run check

ci:
  npm run check:ci
