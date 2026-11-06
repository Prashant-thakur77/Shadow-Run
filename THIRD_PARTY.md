# Third-party licences

Shadow Run's own code is MIT (see [LICENSE](LICENSE)). It uses the components below, each under its own licence. Nothing here is vendored into the source tree except the benchmark tasks and the font subset noted below.

## Used as separate programs, not linked

| Component | Licence | How it's used |
| --- | --- | --- |
| [ShellCheck](https://github.com/koalaman/shellcheck), installed by shellcheck-py (MIT) | GPL-3.0 | The static gate runs the binary as a separate process and reads its JSON. |
| [shfmt](https://github.com/mvdan/sh), installed by shfmt-py (MIT) | BSD-3-Clause | The static gate runs the binary as a separate process and reads the syntax tree it prints. |
| [Microsandbox](https://github.com/superradcompany/microsandbox) | Apache-2.0 | The runner uses it to start each rehearsal microVM. |
| PostgreSQL, inside the sandbox image | PostgreSQL Licence | The clone's database. |

## Python libraries

| Library | Licence |
| --- | --- |
| [psycopg](https://www.psycopg.org/) and psycopg-binary | LGPL-3.0, used as an unmodified library |
| FastAPI, sqlglot, MCP SDK, PyYAML, pydantic | MIT |
| uvicorn, httpx | BSD-3-Clause |
| OpenAI SDK, boto3 | Apache-2.0 |

## Web

| Package | Licence |
| --- | --- |
| React, React Flow (@xyflow/react), Lenis, react-diff-viewer-continued | MIT |
| Fonts, via Fontsource: Archivo, Geist, Geist Mono, Doto. `web/src/fonts/archivo-72-700-caps.woff2` is a subset of Archivo. | SIL OFL 1.1 |

Build tools are listed in `web/package-lock.json` with their licences.

## Benchmark tasks

`bench/tasks/saber_*.yaml` are adapted from [SABER](https://github.com/sssr-lab/saber) ([EMNLP 2026 paper](https://aclanthology.org/2026.emnlp-main.211/)), whose task texts are CC-BY-4.0. They were rewritten for this project's targets, with our own seed data and oracles.
