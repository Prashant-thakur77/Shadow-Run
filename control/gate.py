"""Static gate. Runs before any rehearsal, and is also the baseline in the benchmark.

Three verdicts: `block` (never rehearsed or applied), `review` (rehearsed, always needs a person),
`pass`. Anything the parser cannot understand is at least `review`: unknown is not safe.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from typing import Any

import bashlex
import sqlglot
from sqlglot import exp
from sqlglot.dialects.postgres import Postgres
from sqlglot.tokens import TokenType

logging.getLogger("sqlglot").setLevel(logging.ERROR)

READ = "read"
REVERSIBLE = "reversible_write"
IRREVERSIBLE = "irreversible_write"
RANK = {READ: 0, REVERSIBLE: 1, IRREVERSIBLE: 2}

# Statements that break the one-transaction envelope, reach outside the database, or try to hide from the record.
BLOCK_COMMANDS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"\b(disable|enable)\s+(always\s+|replica\s+)?(trigger|rule)\b|\bdrop\s+trigger\b|\bsession_replication_role\b", re.I),
     "tampering", "a plan may not disable triggers: they enforce the application's rules and record what happened"),
    (re.compile(r"\bpg_temp\b|\bbefore_[a-z_0-9]+\b", re.I),
     "tampering", "a plan may not touch temporary tables: the guardrail baselines live there"),
    (re.compile(r"\balter\s+(table|view|sequence|function)\b[\s\S]*\bowner\s+to\b", re.I),
     "privilege_change", "a plan may not change who owns an object"),
    (re.compile(r"^\s*(begin|start\s+transaction|commit|end|abort|rollback|savepoint|release|prepare\s+transaction)\b", re.I),
     "transaction_control", "a plan may not control the transaction it runs in"),
    (re.compile(r"^\s*set\s+(local\s+|session\s+)?(role|session\s+authorization)\b", re.I),
     "privilege_change", "a plan may not change the role it runs as"),
    (re.compile(r"^\s*(alter\s+system|create\s+extension|load\b|create\s+(or\s+replace\s+)?(language|server)|alter\s+role|create\s+role|create\s+user|drop\s+role|drop\s+user|grant\b|revoke\b)", re.I),
     "privilege_change", "a plan may not change roles, grants, extensions or server settings"),
    (re.compile(r"\bcopy\b[\s\S]*\b(program|from\s+'/|to\s+'/)", re.I),
     "server_file_access", "COPY to or from the server filesystem or a program reaches outside the database"),
    (re.compile(r"^\s*(vacuum|reindex\s+.*concurrently|cluster\b|create\s+(unique\s+)?index\s+concurrently|drop\s+index\s+concurrently|create\s+database|drop\s+database|alter\s+database)\b", re.I),
     "not_transactional", "this statement cannot run inside the single apply transaction; rewrite it without CONCURRENTLY or handle it outside the plan"),
]

BLOCK_FUNCTIONS = {
    "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "lo_import", "lo_export", "lo_put", "lo_from_bytea",
    "dblink", "dblink_exec", "dblink_connect", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
    "pg_rotate_logfile", "set_config", "pg_advisory_lock", "query_to_xml", "pg_sleep",
}
SIDE_EFFECT_FUNCTIONS = {"http_get", "http_post", "http", "pg_notify", "net.http_post", "send_email", "sendmail"}


# A guardrail reads as a rule to a person, and runs on prod inside the apply transaction, so it must only read.
GUARDRAIL_REFUSED_NODES = tuple(
    getattr(exp, name)
    for name in ("Insert", "Update", "Delete", "Merge", "Create", "Drop", "Alter", "TruncateTable", "Command", "Copy", "Into", "Lock", "Set", "Transaction", "Commit", "Rollback")
    if hasattr(exp, name)
)
GUARDRAIL_REFUSED_FUNCTIONS = re.compile(
    r"\b(pg_sleep\w*|pg_advisory\w*|pg_try_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_promote"
    r"|pg_read\w*|pg_ls\w*|pg_stat_file|pg_stat_reset\w*|pg_notify|pg_logical\w*|pg_replication\w*|pg_create\w*|pg_drop\w*|pg_export\w*"
    r"|lo_\w+|dblink\w*|set_config|setval|nextval|query_to_xml\w*|table_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|cursor_to_xml|http\w*|send_?email|sendmail)\"?\s*\(",
    re.I,
)


def check_guardrail(sql: str) -> str | None:
    """None if this is exactly one query that only reads. Otherwise the reason it can't be a guardrail."""
    try:
        statements = [s for s in sqlglot.parse(sql, read="postgres") if s is not None]
    except Exception as e:
        return f"a guardrail has to parse as SQL: {str(e)[:160]}"
    if len(statements) != 1:
        return f"a guardrail has to be exactly one statement, and this is {len(statements)}"
    root = statements[0]
    if not isinstance(root, exp.Query):
        return "a guardrail has to be a SELECT"
    for node in root.walk():
        if isinstance(node, GUARDRAIL_REFUSED_NODES):
            return f"a guardrail may only read, and this contains {type(node).__name__.upper()}"
    found = GUARDRAIL_REFUSED_FUNCTIONS.search(code_only(sql))
    if found:
        return f"a guardrail may not call {found.group(1)}"
    return None


def _finding(step: int, stmt: str, rule: str, severity: str, reason: str) -> dict:
    return {"step": step, "statement": stmt[:300], "rule": rule, "severity": severity, "reason": reason}


def _is_tautology(where: exp.Expression | None) -> bool:
    if where is None:
        return True
    cond = where.this if isinstance(where, exp.Where) else where
    while isinstance(cond, exp.Paren):
        cond = cond.this
    if isinstance(cond, exp.Boolean):
        return bool(cond.this)
    if isinstance(cond, exp.EQ):
        left, right = cond.left, cond.right
        if isinstance(left, exp.Literal) and isinstance(right, exp.Literal):
            return left.this == right.this
        if isinstance(left, exp.Column) and isinstance(right, exp.Column):
            return left.sql() == right.sql()
    if isinstance(cond, exp.Is) and isinstance(cond.right, exp.Boolean) and cond.right.this:
        return isinstance(cond.left, exp.Boolean) and bool(cond.left.this)
    return False


def code_only(stmt: str) -> str:
    """The statement with its string contents blanked, so a word inside data is not read as a command."""
    try:
        tokens = Postgres().tokenize(stmt)
    except Exception:
        return stmt  # cannot tell code from data, so check everything
    out = stmt
    for tok in reversed(tokens):
        if tok.token_type in (TokenType.STRING, TokenType.HEREDOC_STRING, TokenType.NATIONAL_STRING, TokenType.RAW_STRING, TokenType.UNICODE_STRING):
            out = out[: tok.start] + "''" + out[tok.end + 1 :]
    return out


def check_sql_statement(step: int, stmt: str) -> tuple[list[dict], str]:
    findings: list[dict] = []
    code = code_only(stmt)
    for pattern, rule, reason in BLOCK_COMMANDS:
        # server_file_access has to see the literal: the path is what makes COPY dangerous.
        if pattern.search(stmt if rule == "server_file_access" else code):
            findings.append(_finding(step, stmt, rule, "block", reason))
    if re.match(r"^\s*(copy|notify|listen)\b", stmt, re.I) and not any(f["severity"] == "block" for f in findings):
        findings.append(_finding(step, stmt, "side_effect", "review", "this statement has an effect outside the rehearsed tables"))

    try:
        tree = sqlglot.parse_one(stmt, dialect="postgres")
    except Exception as e:
        findings.append(_finding(step, stmt, "unparseable", "block", f"the SQL parser could not read this statement: {str(e)[:160]}"))
        return findings, IRREVERSIBLE

    for func in tree.find_all(exp.Func):
        name = (func.name if isinstance(func, exp.Anonymous) else func.sql_name()).lower()
        if name in BLOCK_FUNCTIONS:
            findings.append(_finding(step, stmt, "dangerous_function", "block", f"{name}() reaches outside the rehearsed data or holds the session"))
        elif name in SIDE_EFFECT_FUNCTIONS:
            findings.append(_finding(step, stmt, "side_effect", "review", f"{name}() has an effect outside the database that cannot be rehearsed"))

    if re.match(r"^\s*(create\s+(or\s+replace\s+)?(constraint\s+)?(function|procedure|trigger|rule|event\s+trigger)\b|do\b|call\b)", code, re.I):
        findings.append(_finding(step, stmt, "executable_code", "high", "this adds or runs code the parser cannot follow, so it always goes to a person"))
    if re.search(r"\balter\s+column\b[\s\S]*\btype\b", code, re.I) or re.search(r"\bset\s+data\s+type\b", code, re.I):
        findings.append(_finding(step, stmt, "column_rewrite", "high", "changing a column's type can rewrite every row without firing a row trigger"))

    kind = READ
    if isinstance(tree, exp.Drop):
        target = (tree.args.get("kind") or "").upper()
        kind = IRREVERSIBLE
        findings.append(_finding(step, stmt, "drop", "high", f"DROP {target} destroys the object and its data"))
        if tree.args.get("cascade"):
            findings.append(_finding(step, stmt, "drop_cascade", "high", "CASCADE also drops everything that depends on it"))
    elif isinstance(tree, exp.TruncateTable):
        kind = IRREVERSIBLE
        findings.append(_finding(step, stmt, "truncate", "high", "TRUNCATE removes every row"))
        if str(tree.args.get("option") or "").upper() == "CASCADE":
            findings.append(_finding(step, stmt, "truncate_cascade", "high", "TRUNCATE ... CASCADE also empties every table with a foreign key to it"))
    elif isinstance(tree, exp.Delete):
        kind = IRREVERSIBLE
        if _is_tautology(tree.args.get("where")):
            findings.append(_finding(step, stmt, "delete_no_where", "high", "DELETE with no effective WHERE removes every row"))
    elif isinstance(tree, exp.Update):
        kind = REVERSIBLE
        if _is_tautology(tree.args.get("where")):
            findings.append(_finding(step, stmt, "update_no_where", "high", "UPDATE with no effective WHERE changes every row"))
    elif isinstance(tree, exp.Alter):
        kind = REVERSIBLE
        actions = tree.args.get("actions") or []
        if any(isinstance(a, exp.Drop) for a in actions) or re.search(r"\bdrop\s+(column|constraint)\b", stmt, re.I):
            kind = IRREVERSIBLE
            findings.append(_finding(step, stmt, "alter_drop", "high", "ALTER ... DROP removes a column or constraint"))
        if re.search(r"\brename\b", code, re.I):
            findings.append(_finding(step, stmt, "alter_rename", "review", "a rename breaks anything that still uses the old name"))
    elif isinstance(tree, exp.Merge):
        kind = IRREVERSIBLE
    elif isinstance(tree, (exp.Insert, exp.Create)):
        kind = REVERSIBLE
    elif isinstance(tree, exp.Command):
        kind = IRREVERSIBLE
        findings.append(_finding(step, stmt, "opaque_command", "review", "the parser cannot see inside this command, so it is treated as irreversible"))
    elif not isinstance(tree, (exp.Select, exp.Union, exp.Subquery, exp.Show, exp.Describe)) and not isinstance(tree, exp.Query):
        kind = REVERSIBLE
        findings.append(_finding(step, stmt, "unknown_statement", "review", f"statement type {type(tree).__name__} is not specifically understood"))

    # A write hidden inside a CTE or a SELECT still writes, and a DELETE anywhere is irreversible.
    if kind == READ and any(True for _ in tree.find_all(exp.Delete, exp.Update, exp.Insert)):
        kind = IRREVERSIBLE
        findings.append(_finding(step, stmt, "write_in_select", "high", "a data-changing statement is hidden inside a read"))
    elif not isinstance(tree, exp.Delete) and any(True for _ in tree.find_all(exp.Delete)):
        kind = IRREVERSIBLE
        findings.append(_finding(step, stmt, "hidden_delete", "high", "a DELETE is nested inside this statement"))
    return findings, kind


# ---------------------------------------------------------------------- shell

DESTRUCTIVE_COMMANDS = {
    "rm": "deletes files", "shred": "destroys files", "dd": "overwrites raw data", "mkfs": "formats a disk", "wipefs": "wipes a disk",
    "truncate": "empties files", "fdisk": "rewrites a partition table", "parted": "rewrites a partition table",
}
SERVICE_COMMANDS = {"systemctl", "service", "kill", "pkill", "killall", "reboot", "shutdown", "halt", "poweroff", "init", "crontab"}
# These run other programs, so the first word of the command says nothing about what happens.
OPAQUE_COMMANDS = {"bash", "sh", "zsh", "dash", "ksh", "eval", "exec", "source", ".", "python", "python2", "python3", "perl", "ruby", "node", "php", "lua", "awk", "gawk", "busybox", "env", "nohup", "timeout", "xargs", "command", "nice", "setsid", "socat", "openssl"}
EXTERNAL_COMMANDS = {"curl", "wget", "scp", "rsync", "ssh", "sftp", "nc", "ncat", "sendmail", "mail", "aws", "gcloud", "az", "terraform", "kubectl", "stripe", "git"}


def shell_commands(cmd: str) -> list[list[str]]:
    """Every simple command in the script, with its words. Unparseable input raises."""
    out: list[list[str]] = []

    def visit(node) -> None:
        if node.kind == "command":
            out.append([p.word for p in node.parts if p.kind == "word"])
        for attr in ("parts", "list"):
            for child in getattr(node, attr, []) or []:
                visit(child)
        for attr in ("command",):
            child = getattr(node, attr, None)
            if child is not None and hasattr(child, "kind"):
                visit(child)

    for tree in bashlex.parse(cmd):
        visit(tree)
    return out


def run_shellcheck(cmd: str) -> list[dict]:
    binary = shutil.which("shellcheck")
    if not binary:
        return []
    r = subprocess.run([binary, "-f", "json1", "-s", "bash", "-"], input=cmd, capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout or "{}").get("comments", [])
    except ValueError:
        return []


def check_shell_step(step: int, cmd: str) -> tuple[list[dict], str]:
    findings: list[dict] = []
    kind = READ
    try:
        commands = shell_commands(cmd)
    except Exception as e:
        return [_finding(step, cmd, "unparseable", "block", f"could not parse this shell: {str(e)[:160]}")], IRREVERSIBLE

    for words in commands:
        if not words:
            continue
        prog = words[0].rsplit("/", 1)[-1]
        args = words[1:]
        if prog == "sudo" and args:
            prog, args = args[0].rsplit("/", 1)[-1], args[1:]
        flags = "".join(a[1:] for a in args if a.startswith("-") and not a.startswith("--"))
        long_flags = [a for a in args if a.startswith("--")]
        text = " ".join(words)[:300]
        if prog == "rm":
            kind = IRREVERSIBLE
            recursive = "r" in flags.lower() or "--recursive" in long_flags
            targets = [a for a in args if not a.startswith("-")]
            sev = "high" if recursive else "review"
            if any(t in ("/", "~", "~/", "/*", "/home", "/var", "/etc", "/usr", "$HOME") for t in targets) or "--no-preserve-root" in long_flags:
                findings.append(_finding(step, text, "rm_root", "block", "this deletes a top-level directory"))
            else:
                findings.append(_finding(step, text, "rm", sev, "rm deletes files, and -r deletes whole trees" if recursive else "rm deletes files"))
        elif prog in DESTRUCTIVE_COMMANDS:
            kind = IRREVERSIBLE
            findings.append(_finding(step, text, prog, "high", f"{prog} {DESTRUCTIVE_COMMANDS[prog]}"))
        elif prog == "find" and ("-delete" in args or "-exec" in args):
            kind = IRREVERSIBLE
            findings.append(_finding(step, text, "find_delete", "high", "find with -delete or -exec can remove more than it appears to"))
        elif prog in SERVICE_COMMANDS:
            kind = max(kind, REVERSIBLE, key=RANK.get)
            findings.append(_finding(step, text, "service_control", "high", f"{prog} changes running services or processes"))
        elif prog in OPAQUE_COMMANDS:
            kind = IRREVERSIBLE
            findings.append(_finding(step, text, "opaque_command", "high", f"{prog} runs something the gate cannot read, so it always goes to a person"))
        elif prog in EXTERNAL_COMMANDS:
            findings.append(_finding(step, text, "side_effect", "review", f"{prog} reaches outside the host, which cannot be rehearsed"))
        elif prog in ("chmod", "chown") and ("r" in flags.lower() or "--recursive" in long_flags):
            kind = max(kind, REVERSIBLE, key=RANK.get)
            findings.append(_finding(step, text, "recursive_permissions", "high", "a recursive permission change is hard to undo"))
        elif prog in ("mv", "cp", "tee", "sed", "ln", "mkdir", "touch", "tar", "gzip", "apt", "apt-get"):
            kind = max(kind, REVERSIBLE, key=RANK.get)

    if re.search(r"(^|[^<>&0-9])>\s*/", cmd):
        kind = max(kind, IRREVERSIBLE, key=RANK.get)
        findings.append(_finding(step, cmd, "redirect_overwrite", "review", "a redirect overwrites a file"))
    if re.search(r"/dev/(tcp|udp)/", cmd):
        findings.append(_finding(step, cmd, "raw_socket", "high", "bash network redirection reaches outside the host, which cannot be rehearsed"))
    if re.search(r"\|\s*(sudo\s+)?(ba|z|da)?sh\b", cmd):
        findings.append(_finding(step, cmd, "pipe_to_shell", "block", "piping downloaded or generated text into a shell runs code nobody reviewed"))
    if re.search(r":\s*\(\s*\)\s*\{", cmd):
        findings.append(_finding(step, cmd, "fork_bomb", "block", "this looks like a fork bomb"))
    for c in run_shellcheck(cmd):
        if c.get("code") in (2115, 2114, 2216):
            kind = IRREVERSIBLE
            findings.append(_finding(step, cmd, f"SC{c['code']}", "high", c.get("message", "")))
    return findings, kind


# ---------------------------------------------------------------------- whole plan

def check_plan(steps: list[dict], target_kind: str = "postgres") -> dict[str, Any]:
    findings: list[dict] = []
    step_kinds: list[dict] = []
    for idx, step in enumerate(steps, start=1):
        kind = READ
        wanted = "sql" if target_kind == "postgres" else "shell"
        if step["type"] != wanted:
            findings.append(_finding(idx, step["cmd"], "wrong_step_type", "block", f"a {target_kind} target takes {wanted} steps only"))
            step_kinds.append({"step": idx, "risk": IRREVERSIBLE})
            continue
        if step["type"] == "sql":
            for stmt in step["statements"]:
                f, k = check_sql_statement(idx, stmt)
                findings += f
                kind = max(kind, k, key=RANK.get)
        else:
            f, k = check_shell_step(idx, step["cmd"])
            findings += f
            kind = max(kind, k, key=RANK.get)
        step_kinds.append({"step": idx, "risk": kind})
    severities = {f["severity"] for f in findings}
    verdict = "block" if "block" in severities else "review" if severities & {"high", "review"} else "pass"
    return {
        "verdict": verdict,
        "flagged": bool(severities & {"block", "high"}),
        "findings": findings,
        "steps": step_kinds,
        "highest_risk": max((s["risk"] for s in step_kinds), key=RANK.get, default=READ),
    }
