# Mobile Agent

Mobile Agent is an open-source AI agent built specifically for mobile devices that runs entirely on your phone.

## Demo

[![Mobile Agent demo](https://img.youtube.com/vi/_P_SQ0MW-aU/maxresdefault.jpg)](https://youtu.be/_P_SQ0MW-aU?si=klxA4b7RU3Y2j5iy)

## Features

- On-device models that can run completely offline
- Runs completely on-device
- No external server required
- MCP support
- Skills system
- Persistent memory
- Multi-modal support
- Direct access to phone's internal storage
- Android permission-based access

## PC Edition (Windows wrapper)

The same agent, wrapped as a local web tool for your computer — it serves a
polished web UI on a local port and has direct access to the local system
(shell, files, memory), acting as a local AI agent for your PC.

1. **`setup.bat`** — one-time setup (installs dependencies; needs
   [Node.js 20+](https://nodejs.org)).
2. **`start.bat`** — starts the agent at `http://localhost:8787` and opens
   your browser.

Bring your own model: an API key (Anthropic, OpenAI, Google, xAI,
OpenRouter) or a local runtime (Ollama, LM Studio). The project's
`skills/` directory ships with the [hallmark](https://github.com/Nutlope/hallmark)
and [impeccable](https://github.com/pbakaus/impeccable) design skills cloned
from GitHub, which shaped the PC UI and are available to the agent.
See **[pc/README.md](pc/README.md)** for the full guide.

## Installation (Android)

The application is distributed through GitHub Releases.

1. Download the latest APK from the Releases page.
2. Install the APK on your Android device.
3. Grant the required permissions.
4. Start using Mobile Agent.

## Contributing

Contributions are welcome. Feel free to open an issue for bug reports, feature requests, or submit a pull request if you'd like to contribute.

## License

This project is licensed under the MIT License.
