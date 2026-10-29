import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request


REPO = Path(__file__).resolve().parent.parent
if len(sys.argv) < 2:
    raise SystemExit("Usage: python3 scripts/verify-codex-install.py <installed-package-dir> [node]")
PACKAGE = Path(sys.argv[1]).resolve()
NODE = sys.argv[2] if len(sys.argv) > 2 else shutil.which("node")
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def command(args, env):
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr[-2000:]}")
    return result


class FakeModel(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    codex_calls = 0
    pi_calls = 0
    pi_tools = []

    def log_message(self, *args):
        pass

    def send_events(self, events):
        data = "".join(
            (f"event: {event}\n" if event else "") + f"data: {json.dumps(value)}\n\n"
            for event, value in events
        ).encode()
        if not events[0][0]:
            data += b"data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(data)

    # 模拟模型决定工具调用，实际工具仍由 Codex、Pi 和 MCP 执行。
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        if self.path.endswith("/chat/completions"):
            self.reply_to_pi(body)
        else:
            self.reply_to_codex(body)

    def reply_to_pi(self, body):
        FakeModel.pi_calls += 1
        tools = [tool.get("function", {}).get("name") for tool in body.get("tools", [])]
        FakeModel.pi_tools.append(tools)
        last = body["messages"][-1]
        if last.get("role") == "tool":
            content = last.get("content", "")
            delta = {"content": "Tool result: " + (content if isinstance(content, str) else json.dumps(content))}
            finish = "stop"
        else:
            name = "mcp__fixture__echo" if "mcp" in json.dumps(last.get("content", "")).lower() else "fixture_tool"
            delta = {"tool_calls": [{"index": 0, "id": f"pi-{FakeModel.pi_calls}", "type": "function", "function": {"name": name, "arguments": "{}"}}]}
            finish = "tool_calls"
        base = {"id": f"chat-{FakeModel.pi_calls}", "object": "chat.completion.chunk", "created": 1, "model": "fixture"}
        self.send_events([
            (None, {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}),
            (None, {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}),
        ])

    def reply_to_codex(self, body):
        FakeModel.codex_calls += 1
        available = {
            (namespace.get("name"), tool.get("name"))
            for namespace in body.get("tools", []) if namespace.get("type") == "namespace"
            for tool in namespace.get("tools", [])
        }
        steps = {
            1: ("pi_list_models", {}),
            2: ("pi_spawn_agent", {"task": "Use the extension", "model": "local/fixture", "cwd": self.server.workspace}),
            3: ("pi_wait", {"mode": "all", "timeout_sec": 15}),
            5: ("pi_wait", {"mode": "all", "timeout_sec": 15}),
            6: ("pi_list_agents", {}),
        }
        if FakeModel.codex_calls == 4:
            with DIRECT.open(f"http://127.0.0.1:{self.server.service_port}/api/agents") as response:
                agent = json.load(response)[0]
            steps[4] = ("pi_send_followup", {"id": agent["id"], "message": "Use the mcp"})
        step = steps.get(FakeModel.codex_calls)
        if step:
            if ("mcp__pi_subagents", step[0]) not in available:
                raise RuntimeError(f"Codex did not load tool {step[0]}")
            item = {"id": f"fc-{FakeModel.codex_calls}", "type": "function_call", "name": step[0], "namespace": "mcp__pi_subagents", "arguments": json.dumps(step[1]), "call_id": f"call-{FakeModel.codex_calls}", "status": "completed"}
        else:
            item = {"id": "msg-1", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "LOCAL_OK", "annotations": []}]}
        response = {"id": f"resp-{FakeModel.codex_calls}", "object": "response", "created_at": 1, "status": "completed", "model": "mock", "output": [item], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        self.send_events([
            ("response.created", {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}),
            ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": item}),
            ("response.completed", {"type": "response.completed", "response": response}),
        ])


if not NODE or not (PACKAGE / "server.js").is_file():
    raise SystemExit("Usage: python3 scripts/verify-codex-install.py <installed-package-dir> [node]")

with tempfile.TemporaryDirectory(prefix="codex-pi-package-") as temp:
    root = Path(temp)
    codex_home, workspace, pi_config = root / "codex", root / "workspace", root / "pi"
    for directory in (codex_home, workspace, pi_config):
        directory.mkdir()
    (workspace / "README.md").write_text("package test")
    marker = root / "marker"
    marker.write_text("")
    marketplace = root / "marketplace"
    shutil.copytree(PACKAGE / "codex-plugin", marketplace)
    service_port = free_port()
    mcp_config = marketplace / "plugins/pi-subagents/mcp.json"
    mcp_manifest = json.loads(mcp_config.read_text())
    mcp_manifest["mcpServers"]["pi-subagents"]["url"] = f"http://127.0.0.1:{service_port}/mcp"
    mcp_config.write_text(json.dumps(mcp_manifest))

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
    server.service_port, server.workspace = service_port, str(workspace)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    model_port = server.server_address[1]
    (pi_config / "settings.json").write_text(json.dumps({"packages": [str(PACKAGE)], "extensions": [str(REPO / "tests/fixtures/pi-extension.mjs")]}))
    (pi_config / "mcp.json").write_text(json.dumps({"mcpServers": {"fixture": {"command": NODE, "args": [str(REPO / "tests/fixtures/pi-mcp.mjs")], "exposure": "direct"}}}))
    (pi_config / "models.json").write_text(json.dumps({"providers": {"local": {"baseUrl": f"http://127.0.0.1:{model_port}/v1", "api": "openai-completions", "apiKey": "local-fake", "models": [{"id": "fixture"}]}}}))
    env = os.environ.copy()
    env.update({"CODEX_HOME": str(codex_home), "TASK_TEST_API_KEY": "local-fake", "PI_CODING_AGENT_DIR": str(pi_config), "PI_SUBAGENTS_DATA": str(root / "data"), "PI_TEST_MARKER": str(marker)})
    command(["codex", "plugin", "marketplace", "add", str(marketplace), "--json"], env)
    command(["codex", "plugin", "add", "pi-subagents@pi-subagents-local", "--json"], env)
    with (codex_home / "config.toml").open("a") as file:
        file.write('\n[plugins."pi-subagents@pi-subagents-local".mcp_servers.pi-subagents]\ndefault_tools_approval_mode = "approve"\n')

    service = subprocess.Popen([NODE, str(PACKAGE / "server.js"), "--port", str(service_port)], cwd=workspace, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        for _ in range(150):
            if service.poll() is not None:
                raise RuntimeError("Package service exited: " + service.stderr.read()[-2000:])
            try:
                with DIRECT.open(f"http://127.0.0.1:{service_port}/", timeout=0.5) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Package service did not start")

        provider = f'model_providers.test={{name="Test",base_url="http://127.0.0.1:{model_port}/v1",env_key="TASK_TEST_API_KEY",wire_api="responses"}}'
        args = ["codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", str(workspace), "-m", "mock", "-c", 'model_provider="test"', "-c", provider, "Test the packaged plugin"]
        result = command(args, env)
        events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        calls = [event["item"] for event in events if event.get("type") == "item.completed" and event.get("item", {}).get("type") == "mcp_tool_call"]
        assert [call["tool"] for call in calls] == ["pi_list_models", "pi_spawn_agent", "pi_wait", "pi_send_followup", "pi_wait", "pi_list_agents"]
        assert all(call["status"] == "completed" and not call.get("error") for call in calls)
        waits = [json.loads(call["result"]["content"][0]["text"]) for call in calls if call["tool"] == "pi_wait"]
        assert "extension-result" in waits[0]["agents"][0]["result"]
        assert "mcp-result" in waits[1]["agents"][0]["result"]
        thread_id = next(event["thread_id"] for event in events if event.get("type") == "thread.started")
        assert all(wait["agents"][0]["codexThreadId"] == thread_id for wait in waits)
        marker_text = marker.read_text()
        assert marker_text.count("extension-start") >= 2 and marker_text.count("extension-stop") >= 2
        assert marker_text.count("mcp-start") >= 2 and marker_text.count("mcp-stop") >= 2
        assert all("pi_spawn_agent" not in tools for tools in FakeModel.pi_tools)
        assert any("fixture_tool" in tools and "mcp__fixture__echo" in tools for tools in FakeModel.pi_tools)
        for asset in ("/", "/vendor/marked.js", "/vendor/mermaid.js", "/vendor/dompurify.js", "/fonts/OpenAISans-Regular-c56711d328c4.woff2"):
            with DIRECT.open(f"http://127.0.0.1:{service_port}{asset}") as response:
                assert response.status == 200
        print("PASS packaged Codex plugin, agent tools, MCP reconnect, thread identity, and panel assets")
    finally:
        service.terminate()
        try:
            service.wait(timeout=7)
        except subprocess.TimeoutExpired:
            service.kill()
            service.wait()
        server.shutdown()
