set shell := ["zsh", "-cu"]

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

ast:
  npm run ast:test
  npm run ast

check:
  npm run check
