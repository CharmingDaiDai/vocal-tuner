#!/usr/bin/env python3
"""
Vocal Tuner — 统一启动脚本

用法：
  python start.py           # 生产模式：构建前端 + 稳定运行（无 reload）
  python start.py --rebuild # 强制重新 build 前端
  python start.py --dev     # 开发模式：跳过前端 build，仅监视 .py 文件热重载
  python start.py --reload  # 显式开启热重载（仅监视 .py 文件，排除 static/uploads/sessions）

局域网访问：本脚本会打印局域网 IP 地址。
"""

import argparse
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT     = Path(__file__).parent
BACKEND  = ROOT / "backend"
FRONTEND = ROOT / "frontend-react"
STATIC   = BACKEND / "static"


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def free_port(port: int) -> bool:
    """检查端口是否可用；若被占用则尝试 kill 占用进程。返回最终是否可用。"""
    # 先用 socket 探测
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return True  # 端口空闲
        except OSError:
            pass  # 被占用，继续处理

    print(f"[!] 端口 {port} 被占用，正在自动清理…")

    if sys.platform == "win32":
        # netstat -ano | findstr :<port>
        try:
            out = subprocess.check_output(
                ["netstat", "-ano"], text=True, stderr=subprocess.DEVNULL
            )
            pids = set()
            for line in out.splitlines():
                if f":{port} " in line or f":{port}\t" in line:
                    parts = line.split()
                    if parts:
                        try:
                            pids.add(int(parts[-1]))
                        except ValueError:
                            pass
            for pid in pids:
                if pid == 0:
                    continue
                subprocess.run(
                    ["taskkill", "/F", "/PID", str(pid)],
                    capture_output=True,
                )
                print(f"    已终止 PID {pid}")
        except Exception as e:
            print(f"[!] 清理失败：{e}")
            return False
    else:
        # Linux / macOS: lsof -ti :<port> | xargs kill -9
        try:
            out = subprocess.check_output(
                ["lsof", "-ti", f":{port}"], text=True, stderr=subprocess.DEVNULL
            )
            for pid_str in out.strip().splitlines():
                pid = int(pid_str.strip())
                os.kill(pid, 9)
                print(f"    已终止 PID {pid}")
        except Exception as e:
            print(f"[!] 清理失败：{e}")
            return False

    # 等端口释放（最多 3 秒）
    for _ in range(6):
        time.sleep(0.5)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("0.0.0.0", port))
                print(f"[✓] 端口 {port} 已释放")
                return True
            except OSError:
                pass

    print(f"[!] 端口 {port} 仍无法释放，请手动处理后重试")
    return False


def build_frontend(force: bool = False):
    if not FRONTEND.exists():
        print("[!] frontend-react/ 目录不存在，跳过前端构建")
        return

    if not force and STATIC.exists() and any(STATIC.iterdir()):
        print("[✓] 前端已构建（如需重新构建请使用 --rebuild）")
        return

    print("[*] 正在构建前端（npm run build）…")
    result = subprocess.run(
        ["npm", "run", "build"],
        cwd=str(FRONTEND),
        shell=(sys.platform == "win32"),
    )
    if result.returncode != 0:
        print("[!] 前端构建失败")
        sys.exit(1)
    else:
        print("[✓] 前端构建完成")


def main():
    parser = argparse.ArgumentParser(description="Vocal Tuner 启动脚本")
    parser.add_argument("--rebuild", action="store_true", help="强制重新 build 前端")
    parser.add_argument("--dev",     action="store_true", help="开发模式：跳过前端 build，开启 Python 热重载")
    parser.add_argument("--reload",  action="store_true", help="显式开启热重载（仅监视 .py 文件）")
    parser.add_argument("--port",    type=int, default=9000, help="后端监听端口（默认 9000）")
    args = parser.parse_args()

    if not args.dev:
        build_frontend(force=args.rebuild)

    ip   = get_local_ip()
    port = args.port

    if not free_port(port):
        sys.exit(1)

    print()
    print("=" * 50)
    print(f"  Vocal Tuner v2.0")
    print(f"  本机:       http://localhost:{port}")
    print(f"  局域网:     http://{ip}:{port}")
    if args.dev:
        print(f"  前端开发:   http://localhost:5173  (npm run dev)")
    print("=" * 50)
    print()

    cmd = [
        sys.executable, "-m", "uvicorn",
        "main:app",
        "--host", "0.0.0.0",
        "--port", str(port),
    ]

    use_reload = args.dev or args.reload
    if use_reload:
        # 仅监视 backend/ 下的 .py 文件，排除 static/uploads/sessions/worker 进程缓存
        # 避免写入 session/wav/静态文件时触发不必要的服务重启
        cmd += [
            "--reload",
            "--reload-dir", str(BACKEND),
            "--reload-include", "*.py",
            "--reload-exclude", "static/*",
            "--reload-exclude", "uploads/*",
            "--reload-exclude", "sessions/*",
            "--reload-exclude", "__pycache__/*",
        ]
    # 生产模式不加 --reload，服务稳定运行，不受文件写入影响

    os.chdir(str(BACKEND))
    os.execv(sys.executable, cmd)


if __name__ == "__main__":
    main()
