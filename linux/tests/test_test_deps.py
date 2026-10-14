"""linux/tests/requirements.txt names what the Linux tests import, and every runner installs it."""

import ast
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
TESTS = ROOT / "linux" / "tests"
REQUIREMENTS = TESTS / "requirements.txt"
# Import names whose package on PyPI has another name.
PACKAGES = {"yaml": "pyyaml"}


def required() -> set[str]:
    return {line.strip().lower() for line in REQUIREMENTS.read_text().splitlines() if line.strip() and not line.startswith("#")}


def imported() -> set[str]:
    local = {path.stem for path in TESTS.glob("*.py")}
    names = set()
    for path in TESTS.glob("*.py"):
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
    return {PACKAGES.get(name, name) for name in names - set(sys.stdlib_module_names) - local - {"__future__"}}


def test_the_requirements_cover_every_third_party_import():
    assert {"pytest", "pyyaml"} <= required()
    assert imported() - required() == set()


def test_ci_installs_the_requirements_for_the_runner():
    steps = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text())["jobs"]["bridge"]["steps"]
    runs = [step.get("run", "") for step in steps]
    assert "python -m pip install -r linux/tests/requirements.txt" in runs
    assert runs.index("python -m pip install -r linux/tests/requirements.txt") < next(i for i, run in enumerate(runs) if "test-bridge.sh" in run)


def run_runner(tmp_path: Path, python_has: str) -> str:
    bin_dir, log = tmp_path / "bin", tmp_path / "ran"
    bin_dir.mkdir()
    python = bin_dir / "python"
    python.write_text(
        "#!/usr/bin/env bash\n"
        f'if [[ "$1" == -c ]]; then for m in ${{2//,/ }}; do [[ "$m" == import || " {python_has} " == *" $m "* ]] || exit 1; done; exit 0; fi\n'
        f'echo "python $*" >>"{log}"\n'
    )
    uv = bin_dir / "uv"
    uv.write_text(f'#!/usr/bin/env bash\necho "uv $*" >>"{log}"\n')
    for tool in (python, uv):
        tool.chmod(0o755)
    subprocess.run(
        ["bash", str(ROOT / "scripts" / "test-bridge.sh")],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path), "HERALD_OS_PYTHON": str(python)},
        check=True,
    )
    return log.read_text()


def test_the_runner_uses_a_python_that_has_pytest_and_pyyaml(tmp_path):
    assert run_runner(tmp_path, "pytest yaml").startswith("python -m pytest -q . ")


def test_the_runner_falls_back_to_uv_with_the_requirements_when_pyyaml_is_missing(tmp_path):
    ran = run_runner(tmp_path, "pytest")
    assert ran.startswith("uv run ")
    assert f"--with-requirements {REQUIREMENTS} " in ran
