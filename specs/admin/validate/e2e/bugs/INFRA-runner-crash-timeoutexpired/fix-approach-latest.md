The crash was caused by `subprocess.run("adb logcat -d -t 200 '*:E'", timeout=15)` in
`parallel_runner.py` (line 14822) raising an uncaught `subprocess.TimeoutExpired` when the
emulator was slow to respond to logcat. The fix — wrapping the call in
`try/except subprocess.TimeoutExpired` and increasing the timeout from 15 to 30 seconds —
was already applied to `parallel_runner.py` in a prior iteration (the file shows
`timeout=30` and an except block at line 14828 that sets `crash_lines = "(logcat timed out
— emulator may be unresponsive)"`). The exception is now caught and the E2E loop continues
rather than crashing. Verified by inspecting `parallel_runner.py` lines 14822-14829.
