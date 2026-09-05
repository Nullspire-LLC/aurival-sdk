<p align="center">
  <a href="https://bots.aurival.com/docs"><img src="https://raw.githubusercontent.com/Nullspire-LLC/aurival-sdk/main/assets/aurival-banner.png" alt="Aurival" width="100%"></a>
</p>
<p align="center">Write a bot for Aurival. Declare commands, call <code>run()</code>, and the SDK holds the socket.</p>
<p align="center">
  <a href="https://pypi.org/project/aurival/"><img src="https://img.shields.io/pypi/v/aurival.svg" alt="PyPI version"></a>
  <a href="https://www.npmjs.com/package/aurival"><img src="https://img.shields.io/npm/v/aurival.svg" alt="npm version"></a>
  <a href="https://github.com/Nullspire-LLC/aurival-sdk/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

This repository holds the official Aurival bot SDKs:

- [`python/`](python/README.md) — the `aurival` package for Python 3.10+
- [`js/`](js/README.md) — the `aurival` package for Node.js 22+

## Install

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install aurival
```

The first line matters on current Debian, Ubuntu and Fedora, whose system Python refuses `pip install` outside a virtual environment (PEP 668).

```bash
npm install aurival
```

## Docs

Full documentation, quick-start guides, and the command reference live at
[bots.aurival.com/docs](https://bots.aurival.com/docs).

## License

Apache-2.0, see [LICENSE](LICENSE) (each package ships its own copy). The Aurival name, wordmark, and mascot are trademarks of Nullspire LLC and are not covered by the license, see [NOTICE](NOTICE).
