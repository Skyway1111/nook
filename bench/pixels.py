# Types into the focused window through XTest and times each key until a region of the screen changes:
#   python3 bench/pixels.py X Y W H N
# Sends N keys 100 ms apart, every tenth one Return, and prints the ms each other key took to change the
# region, as JSON. bench/linux.mjs points it at the composer's draft, which is opaque, so a wallpaper moving
# under the terminal never changes it. Timing pixels counts what the page's own clock can't: WebKit handing
# its frame to the window. Needs only libX11 and libXtst, which xdotool brings.
import ctypes, json, sys, time

x, y, w, h, n = map(int, sys.argv[1:6])
X = ctypes.CDLL('libX11.so.6')
XTest = ctypes.CDLL('libXtst.so.6')
X.XOpenDisplay.restype = ctypes.c_void_p
X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X.XDefaultRootWindow.restype = ctypes.c_ulong
X.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                        ctypes.c_ulong, ctypes.c_int]
X.XGetImage.restype = ctypes.c_void_p
X.XStringToKeysym.argtypes = [ctypes.c_char_p]
X.XStringToKeysym.restype = ctypes.c_ulong
X.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
X.XFlush.argtypes = [ctypes.c_void_p]
X.XFree.argtypes = [ctypes.c_void_p]
XTest.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

display = X.XOpenDisplay(None)
if not display:
    sys.exit('no display')
root = X.XDefaultRootWindow(display)
Z_PIXMAP = 2


def grab():
    image = X.XGetImage(display, root, x, y, w, h, 0xFFFFFFFF, Z_PIXMAP)
    data = ctypes.cast(image, ctypes.POINTER(ctypes.c_void_p))[2]  # XImage: four ints, then char *data
    pixels = ctypes.string_at(data, w * h * 4)
    X.XFree(data)
    X.XFree(image)
    return pixels


def press(name):
    code = X.XKeysymToKeycode(display, X.XStringToKeysym(name))
    XTest.XTestFakeKeyEvent(display, code, 1, 0)
    XTest.XTestFakeKeyEvent(display, code, 0, 0)
    X.XFlush(display)


times = []
for k in range(n):
    start = time.perf_counter()
    if k % 10 == 9:
        press(b'Return')
    else:
        before = grab()
        start = time.perf_counter()
        press(b'a')
        while time.perf_counter() - start < 0.09:
            if grab() != before:
                times.append(round((time.perf_counter() - start) * 1000, 1))
                break
    time.sleep(max(0, 0.1 - (time.perf_counter() - start)))
print(json.dumps(times))
