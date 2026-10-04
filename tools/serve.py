# 本地静态服务器（等价于 GitHub Pages 的静态托管行为）
# 用途：本地验收、手机同局域网访问真机测试
#
#   python tools/serve.py            # 默认 http://127.0.0.1:8080
#   python tools/serve.py -p 8123    # 换端口
#   python tools/serve.py --lan      # 监听 0.0.0.0，手机可用局域网 IP 访问
import argparse
import http.server
import socket
import socketserver
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # 支持 keep-alive，与现代浏览器行为一致

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # 本地调试时禁止缓存，改完刷新即生效；线上由 Service Worker 负责缓存
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} - {fmt % args}")


class ThreadingServer(socketserver.ThreadingTCPServer):
    """必须是多线程：ES Module 会产生大量并行请求，
    单线程 TCPServer 会被 keep-alive 连接堵死，表现为浏览器端 ERR_CONNECTION_REFUSED。"""

    allow_reuse_address = True
    daemon_threads = True


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=8080)
    ap.add_argument("--lan", action="store_true", help="监听所有网卡，方便手机访问")
    args = ap.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    with ThreadingServer((host, args.port), partial(Handler, directory=str(ROOT))) as httpd:
        print(f"WeatherRoulette 本地服务已启动，根目录 {ROOT}")
        print(f"  本机访问：http://127.0.0.1:{args.port}/")
        if args.lan:
            print(f"  手机访问：http://{lan_ip()}:{args.port}/")
        print("  按 Ctrl+C 停止")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
