#!/usr/bin/env python3
"""대화형 claude를 pty로 띄워 화면을 캡처한다. 프롬프트를 보내지 않으면 모델 사용량이 들지 않는다.
사용: screen.py <cwd> <seconds> [keys...] -- <command...>
keys는 순서대로 보낸다. 형식: 'wait:2'(초 대기), 'text:/mcp'(문자열), 'enter', 'esc', 'down'.
출력: 마지막 화면 텍스트(ANSI 제거, 공백 압축)를 stdout으로.
"""
import os, pty, re, select, sys, time, fcntl, termios, struct

cwd, seconds = sys.argv[1], float(sys.argv[2])
sep = sys.argv.index("--")
keys, cmd = sys.argv[3:sep], sys.argv[sep + 1:]
ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[=>78]")
KEYS = {"enter": b"\r", "esc": b"\x1b", "down": b"\x1b[B", "up": b"\x1b[A"}

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
buf = b""

def pump(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf += data
    return True

alive = pump(min(seconds, 6))
marks = []
for k in keys:
    if not alive:
        break
    if k.startswith("wait:"):
        alive = pump(float(k[5:]))
        continue
    marks.append(len(buf))
    os.write(fd, k[5:].encode() if k.startswith("text:") else KEYS[k])
    alive = pump(0.4)
if alive:
    pump(max(0.0, seconds - 6))
exited = os.waitpid(pid, os.WNOHANG)[0] != 0
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
text = ANSI.sub(b"", buf).decode("utf8", "replace")
text = re.sub(r"[ \t]+", " ", text)
text = "\n".join(l.strip() for l in text.splitlines() if l.strip())
print(text[-6000:])
print(f"\n[screen.py] exited_by_itself={exited}")
