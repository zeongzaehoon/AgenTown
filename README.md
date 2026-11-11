# AgenTown

> **Where agents come alive.**

AgenTown은 LLM 에이전트로 업무 자동화와 프로젝트 생성·구현을 수행하는 macOS·Windows용 프로그램입니다.
직원 역할의 에이전트를 만들고 TF 팀을 구성해 Task를 할당하며, 작업 진행을 2D·3D 회사 운영 화면으로 보여주는 것을 목표로 합니다.

제품 목표와 기술 원칙은 [PLAN.md](PLAN.md)에 정리되어 있습니다.
제품 Rust Core는 에이전트와 Task 생성·조회, 여러 에이전트 할당, Task 상태 전이를 지원합니다.
SQLite 어댑터를 통해 에이전트, Task, 할당을 저장하고 재시작 후 복원할 수 있습니다.
[Core 설계와 API 계약](docs/core.md), [저장소 사용법과 스키마](docs/persistence.md)를 참고하세요.

Rust/Cargo를 설치한 뒤 제품 테스트를 실행합니다:

```sh
cargo test --manifest-path rust/Cargo.toml --workspace --locked
```

Python 3.13 CLI 설치와 macOS/Windows 에이전트 생성·Task 할당 예제는
[Python CLI 안내](docs/python-cli.md)를 참고하세요.

```sh
uv sync --directory python --locked
uv run --directory python --locked agentown --help
uv run --directory python --locked python -m pytest
```

Read-only external inspection is available through the packaged
[`agentown-mcp` stdio server](docs/mcp.md), with Codex and Claude Code connection
examples and a four-tool agent/Task query contract.

Text execution through Anthropic, OpenAI, AWS Bedrock and xAI (Grok) is available
with `agentown ... work execute --provider PROVIDER --model MODEL_ID`.
See [provider SDK configuration](docs/providers.md).
See [configuration, execution and restart recovery](docs/text-execution.md).
Responses remain unverified; live validation remains outstanding.

After `npm --prefix frontend ci`, `npm --prefix frontend run build` (Node 24.15+ in the Node 24 line) and
`uv run --directory python --locked maturin develop --locked`, the React + TypeScript
[local employee and work screen](docs/local-screen.md) launches with
`uv run --directory python --locked agentown-web --database /tmp/llm-work.sqlite3 --model YOUR_MODEL_ID`.
Open `http://127.0.0.1:8765` to create an employee, save assigned text, execute it,
and inspect unverified results and retry history. Supply the Anthropic key in the
server environment. See the walkthrough for Windows paths and validation limits.

## Repository layout

- `frontend/`: React + TypeScript project, npm manifests and Vite configuration.
- `rust/`: Cargo workspace, shared lockfile and product crates.
- `python/`: Python project and lockfile; application code in `src/llm_engine/`, tests in `tests/`.
- `docs/`: product documentation. Local development tooling remains in ignored `.agents/` and `.harness/`.

Run commands below from the repository root, with Node 24, Python 3.13 and Rust installed:

```sh
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run build
cargo test --manifest-path rust/Cargo.toml --workspace --locked
uv sync --directory python --locked
uv run --directory python --locked python -m pytest
uv run --directory python --locked agentown-web --help
```

Build frontend assets before building or testing installed Python packages. Historical files in `docs/evidence/` retain the paths that existed when they were recorded.

Desktop source build and owned-service lifecycle: see [desktop instructions](docs/desktop.md).
