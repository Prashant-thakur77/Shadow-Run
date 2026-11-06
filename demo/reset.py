"""Reset the demo prod to its seeded state. Used by the demo reset button and by tests."""
from __future__ import annotations

import psycopg

from demo.seed import seed


def reset(conn_kwargs: dict, scale: float = 1.0) -> dict[str, int]:
    with psycopg.connect(**conn_kwargs, autocommit=True) as c:
        c.execute("DROP SCHEMA IF EXISTS public CASCADE")
        c.execute("CREATE SCHEMA public")
    with psycopg.connect(**conn_kwargs) as c:
        return seed(c, scale=scale)
