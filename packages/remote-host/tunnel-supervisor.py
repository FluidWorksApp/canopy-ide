#!/usr/bin/env python3
"""Supervise a local forwarding process by testing traffic, not just its PID.

Only the forwarding process group is restarted. No remote lifecycle operations.
"""
import argparse
import json
import os
import random
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


def reachable(url):
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=4):
            return True
    except urllib.error.HTTPError:
        # An HTTP error (including unauthenticated 401) proves traffic flows.
        # Service/auth errors must not trigger tunnel restart storms.
        return True
    except (OSError, urllib.error.URLError, TimeoutError):
        return False


class Health:
    def __init__(self, now):
        self.started = now
        self.failures = 0
        self.healthy_since = None

    def observe(self, ok, now):
        if ok:
            self.failures = 0
            if self.healthy_since is None:
                self.healthy_since = now
        else:
            self.healthy_since = None
            if now - self.started >= 30:
                self.failures += 1
        return self.failures >= 3


def retry_delay(attempt):
    return min(30, 2 ** min(attempt, 5)) + random.uniform(0, 1)


def stop_group(child):
    # Kill descendants even if the forwarding parent already exited.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not 1024 <= args.port <= 65535:
        parser.error('A forwarding command and valid local port are required')
    stopped = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.set())
    previous = None

    def state(phase, attempt=0):
        nonlocal previous
        if previous == (phase, attempt):
            return
        previous = (phase, attempt)
        record = dict(phase=phase, attempt=attempt, updatedAt=time.time())
        tmp = args.state.with_suffix('.tmp')
        tmp.write_text(json.dumps(record) + '\n')
        tmp.chmod(0o600)
        tmp.replace(args.state)
        print(json.dumps(record), flush=True)

    attempt = 0
    while not stopped.is_set():
        state('connecting', attempt)
        child = None
        try:
            child = subprocess.Popen(command, start_new_session=True)
            health = Health(time.monotonic())
            while not stopped.is_set() and child.poll() is None:
                ok = reachable(f'http://127.0.0.1:{args.port}/health')
                now = time.monotonic()
                unhealthy = health.observe(ok, now)
                if ok:
                    state('connected')
                    if now - health.healthy_since >= 60:
                        attempt = 0
                else:
                    state('reconnecting', attempt + 1)
                if unhealthy:
                    break
                stopped.wait(5)
        except OSError:
            state('reconnecting', attempt + 1)
        finally:
            if child is not None:
                stop_group(child)
        if not stopped.is_set():
            attempt += 1
            state('reconnecting', attempt)
            stopped.wait(retry_delay(attempt))
    state('stopped')


if __name__ == '__main__':
    main()
