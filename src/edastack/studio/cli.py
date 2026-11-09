"""CLI entry point for starting the local Studio API."""

from __future__ import annotations

import argparse
import os

import uvicorn

from edastack.studio.api import app


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local EDA Studio API")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("EDA_STUDIO_PORT", "8765")),
        help="loopback port to listen on (default: 8765)",
    )
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    uvicorn.run(app, host="127.0.0.1", port=args.port, reload=False, log_level="info")
