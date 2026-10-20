# OpenClawX AgentScope Runtime

Local Python Sidecar for OpenClawX. Speaks **WebSocket JSON-RPC 2.0** on loopback.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m openclawx_agentscope_runtime --host 127.0.0.1 --port 4321 --token dev-token
```

Connect: `ws://127.0.0.1:4321/v1/agent?token=dev-token`

See `docs/design/agentscope-abi.md` for methods and AgentEvent mapping.
