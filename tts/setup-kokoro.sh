#!/bin/bash
# One-time setup for the Kokoro TTS engine (local neural text-to-speech).
# Creates a Python venv and downloads the model (~310 MB) + voices (~27 MB).
set -e
cd "$(dirname "$0")"

echo "→ Creating Python venv..."
python3 -m venv venv
./venv/bin/pip install --quiet --upgrade pip
./venv/bin/pip install --quiet kokoro-onnx soundfile

echo "→ Downloading model files (~340 MB total)..."
mkdir -p models
[ -f models/kokoro-v1.0.onnx ] || curl -L --progress-bar -o models/kokoro-v1.0.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
[ -f models/voices-v1.0.bin ] || curl -L --progress-bar -o models/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

echo "→ Testing..."
./venv/bin/python kokoro-tts.py --text "Hello. I am Eli." --voice bm_george --out /tmp/kokoro-test.wav
echo "✓ Kokoro ready — test file at /tmp/kokoro-test.wav"
