# Kokoro TTS runner — called by local-server.mjs (/api/tts, engine "kokoro").
# Local neural text-to-speech; nothing leaves the machine.
#
#   venv/bin/python kokoro-tts.py --text "..." --voice bm_george --speed 1.0 --out out.wav
#
# Set up once with: bash tts/setup-kokoro.sh

import argparse
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))

parser = argparse.ArgumentParser()
parser.add_argument('--text', required=True)
parser.add_argument('--voice', default='bm_george')
parser.add_argument('--speed', type=float, default=1.0)
parser.add_argument('--out', required=True)
args = parser.parse_args()

model_path  = os.path.join(HERE, 'models', 'kokoro-v1.0.onnx')
voices_path = os.path.join(HERE, 'models', 'voices-v1.0.bin')
if not (os.path.exists(model_path) and os.path.exists(voices_path)):
    sys.exit('Model files missing — run: bash tts/setup-kokoro.sh')

kokoro = Kokoro(model_path, voices_path)
samples, sample_rate = kokoro.create(args.text, voice=args.voice, speed=args.speed, lang='en-gb')
sf.write(args.out, samples, sample_rate)
