# pi-btw

[![npm version](https://img.shields.io/npm/v/@linioi/pi-btw.svg)](https://www.npmjs.com/package/@linioi/pi-btw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/RimuruW/pi-btw/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/RimuruW/pi-btw.svg)](https://github.com/RimuruW/pi-btw)

Side-question extension for [pi](https://github.com/badlogic/pi-mono). Ask one-off questions while the agent is working — without derailing the main session or polluting future context.

## Features

- **`/btw <question>`** — ask a side question at any time, even while the agent is streaming
- **Streaming Markdown UI** — answer renders progressively with syntax-highlighted code blocks, lists, and formatting
- **Concurrent execution** — runs a separate LLM call using the active model, independent of the agent loop
- **Context isolation** — answers are saved as custom messages but excluded from future agent context
- **Abort-safe** — user-initiated cancellation does not affect the ongoing agent turn
- **Uses active model & thinking level** — no separate configuration needed
- **Prompt cache aware** — requests short cache retention to reduce token costs when supported

## How It Works

```
Main session ────────────────────────────────▶ streaming / thinking
                        ↕  (no blocking)
/btw question ───▶ independent LLM call ──▶ saved as custom message (excluded from context)
```

Unlike `followUp` or `steer` (which queue messages for the agent loop), `/btw` opens a parallel `streamSimple` call with the current conversation as context. The answer persists in the session as a `btw-note` custom entry — visible to you, invisible to the agent.

## Quick Start

### Install

```bash
# Via pi package manager
pi install npm:@linioi/pi-btw

# Or from source
git clone https://github.com/RimuruW/pi-btw.git
cd pi-btw
pi install .
```

### Use

```text
/btw what assumptions are we making here?
/btw summarize the trade-off between these two approaches
/btw is there a simpler way to do this?
```

## Why This Exists

During an active coding session, you might want to:
- Clarify a design decision without interrupting the agent's flow
- Research an alternative approach as a parallel investigation
- Ask a meta-question about the conversation so far

Without this extension, you'd need to either wait for the agent to finish (losing momentum) or send a message that gets included in future context (derailing the thread). `/btw` gives you a side channel that stays visible in the session but stays out of the agent's way.

## Project Structure

```
├── index.ts                # Extension entry point — /btw command & context filtering
├── tests/
│   └── btw.test.ts         # Context exclusion & helper tests
├── package.json
└── README.md
```

No build step — pi loads TypeScript extensions directly via `node --experimental-strip-types`.

## Development

```bash
npm run check    # Run tests
npm run prepack  # Run tests before publish
```

## License

[MIT](https://github.com/RimuruW/pi-btw/blob/main/LICENSE)
