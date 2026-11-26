"""A disposable full-screen input target. It never interprets input as shell commands."""
import os
import sys
from pathlib import Path
import re
import tty

tty.setraw(0)
marker = sys.argv[1].encode("ascii")
os.write(1, b"\x1b]2;Shellbell fixture\x07\x1b[?1049h\x1b[2J\x1b[H\x1b[1;31m" + marker + b"\x1b[0m\x1b[3;5H")
if re.fullmatch(r"sbfixture_[a-zA-Z0-9_]+", sys.argv[1]):
    (Path(os.environ["SHELLBELL_TABBY_DIR"]) / (sys.argv[1] + ".ready")).touch()
while True:
    data = os.read(0, 128)
    if not data or b"q" in data:
        break
    if b"x" in data:
        os.write(1, b"RECEIVED")
os.write(1, b"\x1b[?1049l")
