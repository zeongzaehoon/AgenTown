# LLM Engine

PLAN.md의 제품을 반복적으로 개발하기 위한 로컬 하네스부터 구축하고 있습니다.
Python CLI로 조작하고, Rust 엔진이 Codex 실행·상태 저장·재시도를 담당합니다.

```text
회의/회고 → Task 선정 → 구현 → 테스트 → 독립 검토 → 다음 Task
    ↑                                             │
    └─────────────────────────────────────────────┘
```

## 사용

프로젝트 디렉토리에서 실행합니다. Rust와 Python 3.9+, 로그인한 Codex CLI가 필요합니다.

```bash
python3 harness/cli.py build     # Rust 실행 파일 설치
python3 harness/cli.py check     # 실제 검증 실행
python3 harness/cli.py start     # macOS 백그라운드 실행 + 로그인 시 자동 시작
python3 harness/cli.py status    # 현재 Task, 다음 실행 시각, 최근 실행 기록
python3 harness/cli.py pause     # 현재 실행 중단, Task 보존
python3 harness/cli.py resume    # 일시정지/대기 해제
python3 harness/cli.py stop      # 서비스 중지 + 자동 시작 해제
```

`run`은 터미널에서 계속 실행하고, `once`는 **한 단계**만 실행합니다. 서비스 실행 중에는 중복 실행할 수 없습니다.
`resume`는 상태를 재개할 뿐 서비스를 새로 시작하지 않습니다. 서비스를 멈춘 후에는 `start`를 사용합니다.
`service-status`로 macOS 서비스 등록 여부를 확인할 수 있습니다.

컴퓨터가 깨어 있고 로그인되어 있으며 네트워크를 사용할 수 있을 때 진행됩니다.
절전 중에는 실행되지 않으며 깨어나면 이어집니다. 전원 종료 후에는 다음 로그인 때 다시 시작합니다.
서비스는 디스플레이를 켜두거나 시스템 절전 설정을 바꾸지 않습니다.
실행 중에는 로그인한 Codex 계정의 사용량이 소모됩니다.

## 기록과 설정

- `PLAN.md`: 제품 목표와 요구사항.
- `AGENTS.md`, `rules/`: 짧은 진입 지침과 상세 개발 규칙.
- `.agents/skills/`: 프로젝트 전용 Task 순환·아키텍처 지식.
- `harness/roles.md`: 역할별 책임과 검토 관점.
- `harness/config.json`: 실행 모델, 시간 제한, 재시도 간격, 검증 명령.
- `.harness/state.sqlite3`: Task와 단계 체크포인트, 실행 기록, 회고.
- `.harness/runs/`: 실행별 프롬프트, Codex 이벤트, 보고서, 테스트 증거.
- `.harness/service.log`, `.harness/service.error.log`: 백그라운드 서비스 로그.

설정은 프로세스 시작 때 읽습니다. 변경 후 `stop` → `start`로 적용합니다.
하네스 소스를 수정한 경우 `pause` → `check` → `stop` → `build` → `start`로 적용합니다.
설치된 실행 파일은 빌드 산출물과 분리되어 실행 도중의 소스 변경에 영향을 받지 않습니다.

동작과 현재 범위는 [하네스 설계](docs/harness.md)를 참고하세요.
