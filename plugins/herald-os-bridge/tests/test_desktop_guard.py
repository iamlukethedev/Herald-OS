"""The ``pre_tool_call`` guard: shell tools cannot run desktop control past the desktop tool's approvals."""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def desktop(plugin):
    return importlib.import_module(plugin.__name__ + ".bridge.desktop")


RUNS = {
    "the installed binary": "/usr/libexec/herald-os/agent-desktop click @s8f3k2p9:e1",
    "the development VM's": "/usr/local/libexec/herald-os/agent-desktop snapshot --app Firefox",
    "the clipboard helper": "/usr/libexec/herald-os/agent-desktop-linux-clipboard-owner",
    "from its folder": "cd /usr/libexec/herald-os && ./agent-desktop press ctrl+q",
    "by a glob": "/usr/libexec/herald-os/a* close-app Firefox",
    "a copy of it": "cp /usr/libexec/herald-os/agent-desktop /tmp/x && /tmp/x click @s8f3k2p9:e1",
    "a checkout's build": "third_party/agent-desktop/target/release/agent-desktop clipboard-get",
    "cargo run in the checkout": "cd third_party/agent-desktop && cargo run --release -- click @s8f3k2p9:e1",
    "cargo run by package": "cargo run -p agent-desktop -- snapshot",
    "on PATH": "agent-desktop type @s8f3k2p9:e2 hello",
    "with sudo": "sudo agent-desktop status",
    "with a variable": "AGENT=1 agent-desktop status",
    "in a substitution": "echo $(agent-desktop clipboard-get)",
    "found by command -v": "$(command -v agent-desktop) status",
    "after a pipe": "echo x | agent-desktop clipboard-set",
    "upper case": "/USR/LIBEXEC/HERALD-OS/AGENT-DESKTOP status",
}

ALLOWED = {
    "tests in the checkout": "cd third_party/agent-desktop && cargo test --frozen --offline -p agent-desktop-core -p agent-desktop-linux",
    "building it": "cd third_party/agent-desktop && cargo build --release --frozen --offline",
    "reading its notice": "cat third_party/agent-desktop/NOTICE",
    "a quoted path": 'git log --oneline -- "third_party/agent-desktop"',
    "searching for the name": "grep -rn agent-desktop docs/",
    "the sync script": "bash scripts/sync-agent-desktop.sh 9eb9b296192fcb70bda25e918cd6dd66abfa3d0d",
    "listing the folder": "ls -l /usr/libexec/herald-os",
    "anything else": "ls ~/Documents",
}


@pytest.mark.parametrize("name", list(RUNS))
def test_a_terminal_call_that_runs_the_binary_is_blocked(name, desktop):
    verdict = desktop.guard(tool_name="terminal", args={"command": RUNS[name]}, session_id="s", tool_call_id="c")
    assert verdict is not None and verdict["action"] == "block"
    assert "desktop tool" in verdict["message"] and "terminal" in verdict["message"]


@pytest.mark.parametrize("name", list(ALLOWED))
def test_a_terminal_call_that_only_mentions_it_runs(name, desktop):
    assert desktop.guard(tool_name="terminal", args={"command": ALLOWED[name]}) is None


@pytest.mark.parametrize("code", [
    "import subprocess\nsubprocess.run(['/usr/libexec/herald-os/agent-desktop', 'snapshot'])",
    "import subprocess\nsubprocess.run(['agent-desktop', 'click', '@s8f3k2p9:e1'])",
    'import os\nos.system("agent-desktop clipboard-clear")',
    "import os, subprocess\nsubprocess.run([os.path.join('/usr/libexec/herald-os', 'agent-desktop'), 'status'])",
])
def test_execute_code_that_runs_the_binary_is_blocked(code, desktop):
    verdict = desktop.guard(tool_name="execute_code", args={"code": code})
    assert verdict is not None and verdict["action"] == "block" and "execute_code" in verdict["message"]


def test_execute_code_that_does_not_is_left_alone(desktop):
    assert desktop.guard(tool_name="execute_code", args={"code": "print(sum(range(10)))"}) is None


def test_other_tools_and_odd_calls_pass_through(desktop):
    assert desktop.guard(tool_name="read_file", args={"path": "/usr/libexec/herald-os/agent-desktop"}) is None
    assert desktop.guard(tool_name="desktop", args={"command": "status"}) is None
    assert desktop.guard(tool_name="terminal", args=None) is None
    assert desktop.guard(tool_name=None, args={"command": "agent-desktop status"}) is None
    assert desktop.guard() is None


def test_a_command_hidden_in_another_argument_is_still_seen(desktop):
    verdict = desktop.guard(tool_name="terminal", args={"command": "true", "env": {"X": ["/usr/libexec/herald-os/agent-desktop"]}})
    assert verdict is not None and verdict["action"] == "block"


def test_hermes_turns_the_block_into_the_tool_s_result(desktop):
    """Hermes's contract (hermes_cli.plugins): a dict with action "block" and a message vetoes the call."""
    verdict = desktop.guard(tool_name="terminal", args={"command": RUNS["the installed binary"]})
    assert set(verdict) == {"action", "message"} and isinstance(verdict["message"], str) and verdict["message"]


def test_the_guard_takes_every_field_hermes_sends(desktop):
    import inspect

    assert any(p.kind is inspect.Parameter.VAR_KEYWORD for p in inspect.signature(desktop.guard).parameters.values())
    kwargs = {"tool_name": "terminal", "args": {"command": "ls"}, "task_id": "t", "session_id": "s", "tool_call_id": "c", "turn_id": "u", "api_request_id": "a", "middleware_trace": []}
    assert desktop.guard(**kwargs) is None
