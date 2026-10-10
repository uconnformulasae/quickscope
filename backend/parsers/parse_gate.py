"""
Serialized XRK parse gate with priority.

The AiM DLL is not thread-safe; all parses must be exclusive. Interactive
loads (open session, upload) use priority 0; background GPS thumbnails use 1.
"""

from __future__ import annotations

import heapq
import threading
from contextlib import contextmanager
from typing import Iterator

PRIORITY_INTERACTIVE = 0
PRIORITY_PREVIEW = 1


class ParseGate:
    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._busy = False
        self._seq = 0
        self._heap: list[tuple[int, int]] = []

    def acquire(self, priority: int) -> None:
        with self._cond:
            self._seq += 1
            ticket = (priority, self._seq)
            heapq.heappush(self._heap, ticket)
            while True:
                if not self._busy and self._heap and self._heap[0] == ticket:
                    heapq.heappop(self._heap)
                    self._busy = True
                    return
                self._cond.wait()

    def release(self) -> None:
        with self._cond:
            self._busy = False
            self._cond.notify_all()

    @contextmanager
    def hold(self, priority: int = PRIORITY_INTERACTIVE) -> Iterator[None]:
        self.acquire(priority)
        try:
            yield
        finally:
            self.release()


PARSE_GATE = ParseGate()
