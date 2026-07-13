"""Thin negative filter for Codex recall.

Client decides only 'is this obviously not worth asking the server about?'
Server owns all positive recall decisions.
"""

import string

ACKS = frozenset({
    "ok", "okay", "sure", "yes", "yeah", "yep",
    "no", "nah", "nope", "got it", "thanks", "thank you",
    "ty", "noted", "right", "correct", "fine", "cool",
    "great", "nice", "sounds good",
})

SHELL_WORDS = frozenset({
    "ls", "cd", "pwd", "cat", "echo", "mkdir", "rm", "cp", "mv",
    "grep", "find", "git", "npm", "npx", "yarn", "pnpm", "docker", "kubectl",
})

SHELL_FLAGS = ("-", "--")
SHELL_SEPARATORS = (" && ", " || ", " | ", " > ", " < ", ";", "\n")

COMMON_SUBCOMMANDS = frozenset({
    "status", "diff", "log", "show", "commit", "push", "pull",
    "install", "run", "test", "build", "exec", "apply", "get",
})


def _normalize(prompt: str) -> str:
    return " ".join(prompt.strip().split())


def is_empty(prompt: str) -> bool:
    return not prompt.strip()


def is_punctuation_only(prompt: str) -> bool:
    stripped = prompt.strip()
    return bool(stripped) and all(ch in string.punctuation for ch in stripped)


def is_slash_command(prompt: str) -> bool:
    return prompt.lstrip().startswith("/")


def is_ack(prompt: str) -> bool:
    normalized = _normalize(prompt).lower().rstrip(".!?")
    return normalized in ACKS


def looks_like_shell_command(prompt: str) -> bool:
    normalized = _normalize(prompt)
    if not normalized:
        return False
    parts = normalized.split()
    first = parts[0].lower()
    if first not in SHELL_WORDS:
        return False
    if len(parts) == 1:
        return True
    second = parts[1]
    if second.startswith(SHELL_FLAGS):
        return True
    if any(sep in prompt for sep in SHELL_SEPARATORS):
        return True
    if "/" in second or "." in second:
        return True
    if second.lower() in COMMON_SUBCOMMANDS:
        return True
    return False


def should_skip_client_recall(prompt: str) -> bool:
    return (
        is_empty(prompt)
        or is_punctuation_only(prompt)
        or is_slash_command(prompt)
        or is_ack(prompt)
        or looks_like_shell_command(prompt)
    )
