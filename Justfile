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

smoke-voice-providers:
  npm run smoke:voice-providers

ast:
  npm run ast:test
  npm run ast

check:
  npm run check

ci:
  npm run check:ci
