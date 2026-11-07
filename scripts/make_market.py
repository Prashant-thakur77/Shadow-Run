#!/usr/bin/env python3
"""Market, revenue and competition facts, each with its source, and the arithmetic done on them. Writes docs/market.json.

Sources were read on Nov 7, 2026. The price is our plan, not a measured figure, and is labelled as such wherever it's shown.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

AGENTS_2025_B = 7.6
AGENTS_2033_B = 182.9
GUARDIAN_LOW, GUARDIAN_HIGH = 10, 15
POSTGRES_COMPANIES = 131339
PRICE_PER_DB_MONTH = 500
FIRST_TARGET_PCT = 1


def main() -> None:
    doc = {
        "as_of": "2026-11-07",
        "agents_market": {
            "usd_b_2025": AGENTS_2025_B,
            "usd_b_2033": AGENTS_2033_B,
            "cagr_pct": 49.6,
            "source": "Grand View Research",
            "url": "https://www.grandviewresearch.com/industry-analysis/ai-agents-market-report",
        },
        "guardian_share": {
            "low_pct": GUARDIAN_LOW,
            "high_pct": GUARDIAN_HIGH,
            "by_year": 2030,
            "source": "Gartner, June 2025",
            "url": "https://www.gartner.com/en/newsroom/press-releases/2025-06-11-gartner-predicts-that-guardian-agents-will-capture-10-15-percent-of-the-agentic-ai-market-by-2030",
        },
        "developers_using_agents": {
            "weekly_pct": 90,
            "daily_pct": 68,
            "respondents": "over 15,000",
            "source": "JetBrains Developer Ecosystem Survey 2026",
            "url": "https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/",
        },
        "agent_incidents": {
            "unexpected_or_unauthorized_pct": 49.8,
            "of_those_modified_or_deleted_data_pct_over": 40,
            "can_stop_automatically_pct": 17.5,
            "respondents": "more than 380 security and technology professionals",
            "source": "Salt Security, State of Agentic AI and API Security 2H 2026",
            "url": "https://campustechnology.com/articles/2026/10/21/unexpected-ai-agent-activity-reported-by-nearly-half-of-organizations-in-recent-survey.aspx",
        },
        "postgres_companies": {
            "count": POSTGRES_COMPANIES,
            "source": "6sense",
            "url": "https://technographics.6sense.com/relational-databases/postgresql-market-share",
            "caveat": "Vendor counts run from about 19,000 to about 173,000, depending on how each defines a user.",
        },
        "price": {
            "usd_per_database_month": PRICE_PER_DB_MONTH,
            "label": "our planned price, not a measured figure and not yet tested with a customer",
        },
        "derived": {
            "tam_usd_b_on_2025_market": [round(AGENTS_2025_B * GUARDIAN_LOW / 100, 2), round(AGENTS_2025_B * GUARDIAN_HIGH / 100, 2)],
            "tam_usd_b_on_2033_forecast": [round(AGENTS_2033_B * GUARDIAN_LOW / 100, 1), round(AGENTS_2033_B * GUARDIAN_HIGH / 100, 1)],
            "tam_how": "Gartner's guardian-agent share applied to Grand View's market size. Two firms' numbers, combined by us.",
            "sam_usd_b_per_year": round(POSTGRES_COMPANIES * PRICE_PER_DB_MONTH * 12 / 1e9, 2),
            "sam_how": "A ceiling: every company using PostgreSQL, one protected database each, at our planned price. Not all of them let agents near prod.",
            "first_target_pct": FIRST_TARGET_PCT,
            "first_target_usd_m_per_year": round(POSTGRES_COMPANIES * FIRST_TARGET_PCT / 100 * PRICE_PER_DB_MONTH * 12 / 1e6, 1),
        },
        "revenue": [
            "A monthly subscription per protected database, since cost grows with database size and not with seats.",
            "A self-hosted licence for regulated teams, who run the control plane and sandboxes on their own Vultr account.",
        ],
        "funnel": [
            "The pull request Action, rehearse only and free: every migration gets a comment saying what it really does.",
            "MCP for the agent: it gives up its database URL, and every change waits for a person.",
            "A short auto-apply list, once the team has seen enough reports.",
        ],
        "next": [
            "Thin clones, so a rehearsal stays fast past a few gigabytes, and masking personal data in the clone.",
            "An auto-apply list that grows: suggest additions from what a team keeps approving, and test each against the attacker first.",
            "First customers: the free Action on real teams' migrations, then paid protected databases.",
        ],
        "competition": [
            {
                "who": "Migration linting and review tools",
                "strength": "Mature, fast, fit CI, and cover many databases. They check each change against a rule set and route it for approval.",
                "gap": "A rule reads the statement. It doesn't measure what the plan really does to a full copy of your data.",
                "urls": [],
            },
            {
                "who": "Thin clones and branches: DBLab, Neon",
                "strength": "Far faster copies than our full restore. DBLab says about 10 seconds for 1 TiB.",
                "gap": "A copy, not a decision: their docs describe no frozen guardrails or approval bound to a measured result. DBLab needs ZFS or LVM, and Neon's branches are on Neon.",
                "urls": ["https://github.com/postgres-ai/database-lab", "https://github.com/neondatabase/mcp-server-neon"],
            },
            {
                "who": "Agent safety tools: safe-migrations-mcp, DryRun",
                "strength": "Simple to start with.",
                "gap": "safe-migrations-mcp simulates on prod in a rolled-back transaction, which still takes locks. DryRun uses sampled rows and only gives advice.",
                "urls": ["https://pypi.org/project/safe-migrations-mcp/", "https://github.com/HMAKT99/DryRun"],
            },
            {
                "who": "A senior engineer reading the SQL",
                "strength": "Knows what the business means, which no check encodes.",
                "gap": "Has to guess what a statement cascades into, and doesn't scale with agents.",
                "urls": [],
            },
        ],
        "us": {
            "strength": "A full clone in a no-network microVM, measured by Postgres. An approval bound to those exact hashes, and an apply that rolls back if prod differs.",
            "weakness": "Full restores get slow on large databases, it covers Postgres and Linux hosts only, and it has no customers yet.",
            "usp": "An approval bound to the measured result of the exact plan, with an apply that rolls back if prod differs. None of the docs above describe that.",
        },
    }
    (ROOT / "docs" / "market.json").write_text(json.dumps(doc, indent=1) + "\n")
    print("wrote docs/market.json", doc["derived"])


if __name__ == "__main__":
    main()
