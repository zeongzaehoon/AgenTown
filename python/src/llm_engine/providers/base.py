from typing import Protocol

class ProviderFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class TextProvider(Protocol):
    name: str

    async def generate(self, text: str, model: str) -> str: ...


