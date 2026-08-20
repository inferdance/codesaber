"""Harbor BaseAgent adapter for saber — wraps `saber exec --json` as a
black-box CLI agent for Terminal-Bench evaluation.

Usage in Harbor:
    harbor run --dataset terminal-bench@2.0 \
        --agent saber --model anthropic/claude-sonnet-4-5 \
        --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
"""

from pathlib import Path

from harbor.agents.base import BaseInstalledAgent, AgentContext


class SaberAgent(BaseInstalledAgent):
    """Adapter that runs saber in a Harbor task environment."""

    NAME = "saber"
    INSTALL_SCRIPT_TEMPLATE = "install-saber.sh.j2"

    def __init__(self, model_name: str, api_key_env: str = "ANTHROPIC_API_KEY", **kwargs):
        super().__init__(**kwargs)
        self.model_name = model_name
        self.api_key_env = api_key_env

    def run(self, instruction: str, environment, context: AgentContext) -> AgentContext:
        result = environment.exec(
            f"saber exec -p {self._shell_quote(instruction)} "
            f"--model {self.model_name} "
            f"--timeout 600 "
            f"--json",
            timeout=1200,
        )
        context.metadata["saber_exit_code"] = result.return_code
        context.metadata["saber_output"] = result.stdout[:10000]
        if result.return_code != 0:
            context.metadata["error"] = f"saber exited {result.return_code}"
        return context

    @staticmethod
    def _shell_quote(text: str) -> str:
        return "'" + text.replace("'", "'\\''") + "'"
