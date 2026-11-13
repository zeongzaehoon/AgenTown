"""Mutation port separate from the read-only selected-work inspection port."""
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..application.execute_selected_work import SelectedWorkExecutionRequest, SelectedWorkExecutionResult


class SelectedWorkExecutionPort(Protocol):
    async def execute_work(self, request: 'SelectedWorkExecutionRequest') -> 'SelectedWorkExecutionResult': ...
