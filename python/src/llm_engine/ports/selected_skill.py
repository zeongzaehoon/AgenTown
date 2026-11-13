"""Installed transport boundary for explicit selected-work Skill application."""
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..application.apply_selected_skill import SelectedSkillRequest, SelectedSkillResult


class SelectedSkillPort(Protocol):
    async def execute_work(self, request: 'SelectedSkillRequest') -> 'SelectedSkillResult': ...
