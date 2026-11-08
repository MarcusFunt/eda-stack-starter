"""Exercise the stdio service through the official MCP Python client."""

import asyncio
import json
import os
import shutil
import sys
import unittest
from pathlib import Path

try:
    from mcp import Client
    from mcp.client.stdio import StdioServerParameters
except ImportError:  # development dependency is optional for runtime-only installs
    Client = None
    StdioServerParameters = None

ROOT = Path(__file__).resolve().parents[1]
NGSPICE = os.environ.get("NGSPICE_EXE") or shutil.which("ngspice")


@unittest.skipUnless(
    Client is not None and NGSPICE, "requires requirements-dev.txt and real ngspice"
)
class McpClientIntegrationTests(unittest.TestCase):
    def test_initialize_list_and_real_verify_call_over_stdio(self):
        server = StdioServerParameters(
            command=sys.executable,
            args=["-m", "edastack.mcp"],
            env={"EDA_STACK_ROOT": str(ROOT), "NGSPICE_EXE": str(NGSPICE)},
            cwd=ROOT,
        )

        async def exercise_client():
            async with Client(server) as client:
                self.assertEqual(client.server_info.name, "edastack-spice")
                tools = await client.list_tools()
                names = {tool.name for tool in tools.tools}
                self.assertEqual(names, {"verify_spice_spec", "eda_toolchain_status"})

                status = await client.call_tool("eda_toolchain_status", {})
                self.assertFalse(status.is_error)
                status_payload = json.loads(status.content[0].text)
                self.assertTrue(status_payload["ngspice_available"])

                result = await client.call_tool(
                    "verify_spice_spec", {"spec": "examples/rc_filter/spec.json"}
                )
                self.assertFalse(result.is_error)
                payload = json.loads(result.content[0].text)
                self.assertTrue(payload["passed"], payload)
                self.assertEqual(len(payload["scenarios"]), 3)
                self.assertTrue(
                    all(scenario["passed"] for scenario in payload["scenarios"])
                )

        asyncio.run(exercise_client())


if __name__ == "__main__":
    unittest.main()
