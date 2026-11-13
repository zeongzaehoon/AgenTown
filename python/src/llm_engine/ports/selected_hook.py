"""Installed transport boundary for explicit selected-work Hook application."""
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..application.apply_selected_hook import SelectedHookRequest, SelectedHookResult


class SelectedHookPort(Protocol):
    async def execute_work(self, request: 'SelectedHookRequest') -> 'SelectedHookResult': ...
