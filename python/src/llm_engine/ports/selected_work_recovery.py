"""Narrow recovery port, separate from inspection and provider execution."""
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..application.reconcile_selected_work import SelectedWorkRecoveryRequest, SelectedWorkRecoveryResult


class SelectedWorkRecoveryPort(Protocol):
    async def reconcile_work(self, request: 'SelectedWorkRecoveryRequest') -> 'SelectedWorkRecoveryResult': ...
