"""Advisory preparation of saved ordinary text; Rust owns eligibility."""
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class TextWorkPreflight:
    task_id: str
    input: str | None
    employee_ids: list[str]
    expected_runs: int
    active_attempt: bool
    eligibility: Literal['missing', 'ineligible', 'eligible']
    resubmission_consent_required: bool


class TextWorkPreflightPort(Protocol):
    def __call__(self, task_id: str) -> TextWorkPreflight: ...


def preflight_text_work(task_id: str, read: TextWorkPreflightPort) -> TextWorkPreflight:
    """Read one coherent snapshot; this result carries no execution authority."""
    return read(task_id)
