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
substitute for later live microphone, speaker, camera, VLM, interaction-ending,
or OTel validation.

The next field milestone is Pi Agent runtime interaction through pico tools:

```bash
node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '<prompt that requires a Pico tool>'
```

This verifies that the actual Pi Agent process can call Pico runtime tools. It
is still not a substitute for microphone, speaker, camera, VLM, or OTel
validation.

Durable memory is outside Pico field validation. If enabled, it is a separately
installed Pi-level plugin and must be validated in the repository or package
that owns its provider, tools, extraction, persistence, retention, and
lifecycle. Do not add a Pico memory smoke or adapter.

Evidence derived from audio, transcripts, devices, credentials, or provider
output may contain only test or session IDs, counts, dimensions, durations, and
status. Do not add raw audio, transcript text, device identifiers, credentials,
or raw provider output.

Visible-person PTZ follow behavior is validated separately from the smoke gate:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
PICO_ENABLE_LIVE_PERSON_FOLLOW_VISIBLE=1 \
npm run field:person-follow-visible-person
```

The visible-person command fails if the run does not observe aggregate person
detections and at least one bounded PTZ move. It records only counts and runtime
status, not identity, bounding boxes, or tracking data.
