"""生成 done-alert 的两个提示音：done.aiff（完成）和 failed.aiff（出错）。

两个声音都是这里从正弦波合成的原创素材，和 mod 一起按 MIT 发布。
用法：python3 sounds/synth.py（只用标准库；转成 AIFF 要 macOS 自带的 afconvert）。
输出写在本脚本所在目录，覆盖同名文件。
"""

import math
import os
import struct
import subprocess
import tempfile
import wave

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))


# 一个音：partials 是 (频率倍数, 振幅, 额外的每秒衰减)；开头 4 毫秒淡入，免得爆音
def note(freq, start, dur, partials, decay, amp=1.0, attack=0.004):
    out = {}
    for i in range(int(dur * SR)):
        t = i / SR
        env = min(1.0, t / attack) * math.exp(-t / decay)
        v = sum(a * math.exp(-t * k) * math.sin(2 * math.pi * freq * r * t) for r, a, k in partials)
        out[int(start * SR) + i] = amp * env * v
    return out


# 叠加几个音，末尾 30 毫秒淡出，按峰值缩放后写成 16 位单声道 AIFF
def render(notes, total, peak, name):
    buf = [0.0] * int(total * SR)
    for nt in notes:
        for i, v in nt.items():
            if i < len(buf):
                buf[i] += v
    fade = int(0.03 * SR)
    for i in range(fade):
        buf[-1 - i] *= i / fade
    scale = peak / max(abs(v) for v in buf)

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, 'sound.wav')
        with wave.open(wav, 'w') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(b''.join(struct.pack('<h', int(v * scale * 32767)) for v in buf))
        subprocess.run(['afconvert', '-f', 'AIFF', '-d', 'BEI16', wav, os.path.join(HERE, name)], check=True)


# 完成：两声柔和的钟音往上走（C6 → G6）
BELL = [(1, 1.0, 0), (2.0, 0.28, 3), (2.76, 0.18, 6), (5.4, 0.06, 12)]
# 出错：两声圆润的低音往下走（A3 → F♯3），不刺耳
MELLOW = [(1, 1.0, 0), (2.0, 0.22, 8), (3.0, 0.06, 14)]

# 峰值按响度对齐 macOS 自带提示音定的：约 −29 dBFS RMS（低音听着偏轻，出错的略高 1 dB）
render([note(1046.5, 0.0, 0.9, BELL, 0.42, 0.85), note(1568.0, 0.11, 0.9, BELL, 0.5)], 1.05, 0.159, 'done.aiff')
render([note(220.0, 0.0, 0.45, MELLOW, 0.16), note(185.0, 0.16, 0.55, MELLOW, 0.2)], 0.72, 0.144, 'failed.aiff')
