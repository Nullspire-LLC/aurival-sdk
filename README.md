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

**Python**

```bash
python3 -m venv .venv
```

```bash
. .venv/bin/activate
```

The first two commands matter on current Debian, Ubuntu and Fedora, whose system Python refuses `pip install` outside a virtual environment (PEP 668).

```bash
pip install aurival
```

**JavaScript**

```bash
npm install aurival
```

## Forms

A bot can put a typed form behind a card button: `Button.form` with up to five fields
(`string`, `paragraph`, `integer`, `decimal`, `email`, `url`, `phone`, `select`, `boolean`).
The person fills it in a sheet and only your bot receives the answers, as a `form.submitted`
event with typed values. See the forms section of each SDK's README:
[`python/`](python/README.md), [`js/`](js/README.md).

- **A card patch is public.** If you ack a submission with new `embeds` or `buttons`, every member
  of the chat sees them. Never echo an answer into the card. Send a private reply in a DM.
- **JavaScript decimals.** `JSON.parse` turns a decimal answer into a double, so `2.10` becomes
  `2.1` and values past about 15 significant digits lose precision. Read `ctx.rawValues` when the
  exact text matters. Python parses decimals as `Decimal`, so `2.10` keeps its scale.
- Both SDKs run the same shared vectors in `testdata/form_vectors.json`.

## Docs

Full documentation, quick-start guides, and the command reference live at
[bots.aurival.com/docs](https://bots.aurival.com/docs).

## License

Apache-2.0, see [LICENSE](LICENSE) (each package ships its own copy). The Aurival name, wordmark, and mascot are trademarks of Nullspire LLC and are not covered by the license, see [NOTICE](NOTICE).
