#!/usr/bin/env python3
"""A minimal MCP server over stdio, for testing the client.

Implements just enough of the protocol to be useful as a fixture: initialize,
tools/list and tools/call. Newline-delimited JSON-RPC on stdin/stdout, with all
diagnostics on stderr so they cannot corrupt the protocol stream.

Deliberately dependency-free so the test suite needs no npx download or network
access.
"""

import json
import sys

TOOLS = [
    {
        "name": "echo",
        "description": "Echoes back the message it is given",
        "inputSchema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
    {
        "name": "explode",
        "description": "Always reports a tool-level error",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def send(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def result(request_id, value):
    send({"jsonrpc": "2.0", "id": request_id, "result": value})


def handle(request):
    method = request.get("method")
    request_id = request.get("id")

    if method == "initialize":
        # Echo the client's protocol version back, so this fixture keeps working
        # as the negotiated version moves.
        version = request.get("params", {}).get("protocolVersion", "2025-06-18")
        result(
            request_id,
            {
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo-fixture", "version": "0.1.0"},
            },
        )
    elif method == "notifications/initialized":
        pass  # A notification: no id, no response.
    elif method == "tools/list":
        result(request_id, {"tools": TOOLS})
    elif method == "tools/call":
        params = request.get("params", {})
        name = params.get("name")
        args = params.get("arguments") or {}

        if name == "echo":
            result(
                request_id,
                {"content": [{"type": "text", "text": f"echo: {args.get('message', '')}"}]},
            )
        elif name == "explode":
            result(
                request_id,
                {"content": [{"type": "text", "text": "deliberate failure"}], "isError": True},
            )
        else:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32602, "message": f"unknown tool: {name}"},
                }
            )
    elif request_id is not None:
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"method not found: {method}"},
            }
        )


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as exc:  # noqa: BLE001 - a fixture, keep it alive
            print(f"fixture error: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
