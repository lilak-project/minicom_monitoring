"""A capture opened late still says what the board said last: the tail, its cut first line dropped.

    backend/.venv or the portal venv: python tests/test_capture_tail.py
"""
import sys, tempfile, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.reader import capture_tail
from app.monitor import board_message
d = tempfile.mkdtemp(); p = os.path.join(d, "c.log")
open(p, "w").write("x" * 20000 + "\nboot\n>>>   1.0 Mb/s   2.0 intr/s   3 intr.  0.00% mem. occupied  ;  1 s since run start <<<\n----- Flushing data -----Disconnecting from data router\n")
t = capture_tail(p)
assert t[-1].startswith("----- Flushing"), t
assert not any(l.startswith("xxx") for l in t), "cut first line kept"
assert board_message(t[-1]) == "Flushing data · Disconnecting from data router", board_message(t[-1])
assert capture_tail(os.path.join(d, "none")) == []
print("ok", t)
