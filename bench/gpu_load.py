"""Load the GPU like a training run: back-to-back fp16 matmuls for N seconds (default 60).
--fill also claims all but 3 GiB of free VRAM, as a big training run does."""
import sys
import time

import torch

args = [a for a in sys.argv[1:] if not a.startswith("--")]
seconds = float(args[0]) if args else 60
if "--fill" in sys.argv:
    free, _ = torch.cuda.mem_get_info()
    ballast = torch.empty(free - (3 << 30), dtype=torch.uint8, device="cuda")
    print(f"holding {ballast.numel() / (1 << 30):.1f} GiB of VRAM")
a = torch.randn(8192, 8192, device="cuda", dtype=torch.float16)
b = torch.randn(8192, 8192, device="cuda", dtype=torch.float16)
end, n = time.time() + seconds, 0
while time.time() < end:
    for _ in range(10):
        a @ b
    torch.cuda.synchronize()
    n += 10
print(f"{n} matmuls, {n * 2 * 8192**3 / seconds / 1e12:.0f} TFLOP/s sustained")
