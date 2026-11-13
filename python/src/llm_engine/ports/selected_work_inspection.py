"""Narrow read-only local connection boundary."""
from typing import Protocol, TYPE_CHECKING
if TYPE_CHECKING:
    from ..application.inspect_selected_work import InspectionResult


class SelectedWorkInspectionPort(Protocol):
    async def inspect_work(self, task_id: str) -> 'InspectionResult': ...
