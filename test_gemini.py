#!/usr/bin/env python3
"""
test_gemini.py — quick check whether Gemini TTS speaks Khmer acceptably,
in a female and a male voice, BEFORE we wire it into the app and bulk-generate.

It writes two files you can play:
    gemini_female.wav   (voice: Kore)
    gemini_male.wav     (voice: Puck)

Setup (one time):
    python -m pip install google-genai
    # get a free key at https://aistudio.google.com/apikey
    $env:GEMINI_API_KEY = "YOUR_GEMINI_KEY"     # PowerShell

Run:
    python test_gemini.py
    python test_gemini.py --text "សួស្តី"       # try your own word/phrase

Then LISTEN to the two .wav files. If the Khmer sounds correct, tell me and
I'll add Gemini (female + male) as the Google-side voices and generate them for
the whole dictionary. If it mispronounces Khmer, we keep the working options
(Microsoft ♀/♂, and gTTS single Google voice).

Notes:
- Gemini TTS returns PCM (24 kHz, 16-bit, mono); this script wraps it as WAV.
- Model defaults to gemini-2.5-flash-preview-tts; override with
  $env:GEMINI_TTS_MODEL if Google changes the name.
"""

import argparse
import os
import sys
import wave

from google import genai
from google.genai import types

MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
VOICES = {"gemini_female.wav": "Kore", "gemini_male.wav": "Puck"}


def synth_to_wav(client, text, voice, path):
    resp = client.models.generate_content(
        model=MODEL,
        contents=text,
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
                )
            ),
        ),
    )
    pcm = resp.candidates[0].content.parts[0].inline_data.data
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)      # 16-bit
        w.setframerate(24000)  # 24 kHz
        w.writeframes(pcm)
    print(f"  wrote {path}  ({len(pcm)} PCM bytes, voice={voice})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default="ភាសាខ្មែរ", help="Khmer text to speak")
    args = ap.parse_args()

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("ERROR: set GEMINI_API_KEY (get one free at https://aistudio.google.com/apikey)")

    client = genai.Client(api_key=key)
    print(f"model={MODEL}  text={args.text!r}")
    for path, voice in VOICES.items():
        try:
            synth_to_wav(client, args.text, voice, path)
        except Exception as e:
            print(f"  FAILED voice={voice}: {type(e).__name__}: {e}")
    print("Done. Play the .wav files and check the Khmer pronunciation.")


if __name__ == "__main__":
    main()
