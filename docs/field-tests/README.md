# Field Validation

`pico` field validation is the completion evidence for resident-agent operation.
Smoke commands are readiness and regression gates only.

Each field test report should record:

- Date and local time.
- Operator.
- Hardware and local services used.
- Config path, without copying secrets.
- Exact launch command.
- Observed behavior.
- Pass/fail result.
- Follow-up issue links for every failed field milestone.

The first field milestone is direct Pi Agent launch with the pico extension:

```bash
node_modules/.bin/pi --approve --no-session --no-tools --extension ./src/index.ts -p '<prompt>'
```

This command verifies the actual Pi Agent extension loading path. It is not a
substitute for later live microphone, speaker, camera, VLM, session cutoff,
memory, or OTel validation.

The next field milestone is Pi Agent runtime interaction through pico tools:

```bash
node_modules/.bin/pi --pico-runtime-profile=interactive --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '<prompt that requires pico_session>'
```

This verifies that the actual Pi Agent process can call pico runtime tools. It
is still not a substitute for microphone, speaker, camera, VLM, memory, or OTel
validation.

Entry-bearing session cutoff through memory and OTel is validated with:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run field:session-memory-lifecycle
```

Use a documented local field config if the production session duration is too
long for a repeatable field run. The command fails unless the cutoff contains at
least one source entry and the same cutoff produces memory and OTel evidence.

Visible-person PTZ follow behavior is validated separately from the smoke gate:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE=1 \
npm run field:person-follow-visible-person
```

The visible-person command fails if the run does not observe aggregate person
detections and at least one bounded PTZ move. It records only counts and runtime
status, not identity, bounding boxes, or tracking data.
