from __future__ import annotations

import argparse
import asyncio

from .server import serve


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenClawX AgentScope runtime (WebSocket JSON-RPC)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 = ephemeral port; print OPENCLAWX_AGENTSCOPE_PORT=N")
    parser.add_argument("--token", default="", help="Required WS query token when non-empty")
    parser.add_argument("--path", default="/v1/agent")
    args = parser.parse_args()
    asyncio.run(serve(host=args.host, port=args.port, token=args.token, path=args.path))


if __name__ == "__main__":
    main()
