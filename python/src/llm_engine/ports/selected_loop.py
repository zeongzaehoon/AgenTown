"""Retained execution-owner boundary for selected-work Loops."""
from typing import Protocol


class SelectedLoopPort(Protocol):
    async def execute_work(self, request): ...
    async def close(self): ...
