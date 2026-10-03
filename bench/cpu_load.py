"""Saturate every CPU core (like data-loader workers) for N seconds (default 60)."""
import multiprocessing as mp
import sys
import time


def spin(until):
    while time.time() < until:
        pass


if __name__ == "__main__":
    until = time.time() + (float(sys.argv[1]) if len(sys.argv) > 1 else 60)
    procs = [mp.Process(target=spin, args=(until,)) for _ in range(mp.cpu_count())]
    for p in procs:
        p.start()
    for p in procs:
        p.join()
