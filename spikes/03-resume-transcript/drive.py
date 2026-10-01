#!/usr/bin/env python3
"""대화형 Claude Code를 pty로 띄워 사람처럼 조작한다.
사용: drive.py <cwd> <screen_log> <prompt> -- <claude args...>
- 신뢰(trust) 확인 창이 뜨면 기록하고 Enter로 수락한다(사람이 수락하는 상황 재현).
- 입력창이 준비되면 prompt를 보내고, 응답이 끝나 입력창이 다시 조용해지면 /exit.
"""
import os, pty, re, select, sys, time, fcntl, termios, struct

cwd, screen_log, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
args = sys.argv[sys.argv.index("--") + 1:]

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b[=>]")
log = open(screen_log, "w")
events = []

def ev(msg):
    t = time.strftime("%H:%M:%S")
    events.append(f"{t} {msg}")
    print(f"[drive] {t} {msg}", flush=True)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(args[0], args)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
buf = b""

def pump(sec):
    """sec초 동안 출력 수집. 마지막 출력 이후 경과 시간을 반환."""
    global buf
    end = time.time() + sec
    last = time.time()
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return None
            if not data:
                return None
            buf += data
            plain = ANSI.sub(b"", data).decode("utf8", "replace")
            log.write(plain)
            log.flush()
            last = time.time()
    return time.time() - last

def screen():
    return ANSI.sub(b"", buf[-20000:]).decode("utf8", "replace")

def wait_for(pattern, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if pump(0.3) is None:
            return False
        if re.search(pattern, screen(), re.I | re.S):
            return True
    return False

def send(text):
    os.write(fd, text.encode())

# 1) 시작: 신뢰 창 또는 입력창
if wait_for(r"trust|안전|Yes, proceed|for shortcuts|\? for", 40):
    s = screen()
    if re.search(r"trust|Yes, proceed", s, re.I):
        # 기본 선택이 "No, exit"이므로 아래로 한 칸 옮겨 "Yes, I trust this folder"를 고른다
        ev("TRUST DIALOG shown")
        # 화살표 키(ESC 시퀀스)는 "Esc to cancel"로 해석돼 종료되므로 숫자 키로 고른다
        send("2")
        pump(1)
        if re.search(r"Yes, ?I ?trust", screen()[-600:], re.I):
            send("\r")
        pump(3)
else:
    ev("no ready marker within 40s")

# 2) 입력창 안정화 후 프롬프트 전송
pump(4)
buf_before = len(buf)
ev("send prompt")
send(prompt)
time.sleep(0.5)
send("\r")

# 3) 응답 대기: 출력이 6초 이상 멈출 때까지 (최대 120초)
end = time.time() + 120
while time.time() < end:
    idle = pump(1)
    if idle is None:
        break
    if idle > 6 and len(buf) > buf_before + 200:
        break
ev("response settled")

try:
    send("/exit")
    time.sleep(0.5)
    send("\r")
    pump(5)
except OSError:
    ev("process already exited")
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
ev("done")
log.write("\n\n=== driver events ===\n" + "\n".join(events) + "\n")
