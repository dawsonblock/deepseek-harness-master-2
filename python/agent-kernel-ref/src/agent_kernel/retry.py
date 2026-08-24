from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")


class ContextWindowExceeded(RuntimeError):
    pass


class TransientModelError(RuntimeError):
    pass


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 5
    base_delay_s: float = 0.5
    max_delay_s: float = 10.0
    jitter_ratio: float = 0.20


async def retry_async(
    operation: Callable[[], Awaitable[T]],
    *,
    policy: RetryPolicy = RetryPolicy(),
    retryable: tuple[type[BaseException], ...] = (TransientModelError, TimeoutError, ConnectionError),
    on_retry: Callable[[int, BaseException, float], None] | None = None,
) -> T:
    last: BaseException | None = None
    for attempt in range(1, policy.max_attempts + 1):
        try:
            return await operation()
        except retryable as exc:
            last = exc
            if attempt >= policy.max_attempts:
                raise
            raw = min(policy.max_delay_s, policy.base_delay_s * (2 ** (attempt - 1)))
            jitter = raw * policy.jitter_ratio
            delay = max(0.0, raw + random.uniform(-jitter, jitter))
            if on_retry:
                on_retry(attempt, exc, delay)
            await asyncio.sleep(delay)
    assert last is not None
    raise last
