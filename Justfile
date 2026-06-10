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

smoke-pi-runtime:
  npm run smoke:pi-runtime

ast:
  npm run ast:test
  npm run ast

check:
  npm run check

ci:
  npm run check:ci
